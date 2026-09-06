import { Logger } from "@nestjs/common";
import type { ComputerService, PageProbe } from "../sandbox/computer.service";
import { normalizeRoute } from "./route-key";

export interface CrawlIdentity {
  id: string;
  name: string;
  role: string;
  isAnonymous: boolean;
  /** Resolved credential values (decrypted), keyed by name. */
  credentials: Record<string, string>;
  login: LoginConfig;
}

export interface LoginConfig {
  /** Path to the login form, relative to the base url. */
  loginPath?: string;
  /** Substring matching the username/email field; defaults tried if absent. */
  userField?: string;
  passField?: string;
  /** Credential key names to type into user/pass. */
  userKey?: string;
  passKey?: string;
  /** Visible text of the submit control. */
  submitText?: string;
  /** A path that means "not logged in" — landing here after submit = failed. */
  loginPathRedirect?: string;
}

export interface CrawlLimits {
  maxNodes: number;
  maxDepth: number;
  /** Seed paths to visit even if nothing links to them. */
  seeds: string[];
  /** Never follow anything matching these (logout, destructive). */
  avoid: RegExp[];
}

export interface VisitResult {
  routeKey: string;
  sampleUrl: string;
  probe: PageProbe;
  depth: number;
  screenshot: string | null;
  /** Neighbour route keys discovered here, with the edge that reaches them. */
  edges: { toKey: string; toSample: string; kind: "link" | "control"; label: string }[];
  /** True when the identity was bounced to login / denied access here. */
  denied: boolean;
}

export type CrawlEvent =
  | { type: "login"; ok: boolean; message: string }
  | { type: "visit"; routeKey: string; depth: number; denied: boolean; linkCount: number };

/**
 * Deterministic breadth-first crawl of one identity's view of the site.
 *
 * The DOM probe (via CDP) is what makes this deterministic: links and controls
 * are read from the rendered page, not guessed from a screenshot, so nothing on
 * the page is missed and the same site produces the same map twice. Route keys
 * (see route-key.ts) are what make it terminate.
 */
export class Crawler {
  private readonly log = new Logger(Crawler.name);

  constructor(
    private readonly computer: ComputerService,
    private readonly port: number,
    private readonly baseUrl: string,
  ) {}

  /** Logs the identity in through the browser. Anonymous identities skip it. */
  async login(identity: CrawlIdentity, emit: (e: CrawlEvent) => void): Promise<boolean> {
    if (identity.isAnonymous) {
      emit({ type: "login", ok: true, message: `${identity.name}：以未登入身份瀏覽` });
      return true;
    }
    const cfg = identity.login;
    const loginUrl = new URL(cfg.loginPath ?? "/login", this.baseUrl).toString();
    const probe = await this.computer.cdpNavigate(this.port, loginUrl, 800);
    if (!probe) {
      emit({ type: "login", ok: false, message: `${identity.name}：登入頁打不開` });
      return false;
    }

    const user = cfg.userKey ? identity.credentials[cfg.userKey] : firstCredential(identity.credentials, ["login", "user", "email", "account"]);
    const pass = cfg.passKey ? identity.credentials[cfg.passKey] : firstCredential(identity.credentials, ["pass", "pwd", "secret"]);
    if (!user || !pass) {
      emit({ type: "login", ok: false, message: `${identity.name}：找不到帳號或密碼憑證` });
      return false;
    }

    const userField = cfg.userField ?? guessUserField(probe) ?? 0;
    const passField = cfg.passField ?? "password";
    const uf = await this.computer.cdpFill(this.port, userField, user);
    const pf = await this.computer.cdpFill(this.port, passField, pass);
    if (!uf.ok || !pf.ok) {
      emit({ type: "login", ok: false, message: `${identity.name}：填不進登入欄位（${uf.error ?? pf.error ?? ""}）` });
      return false;
    }
    const submit = await this.computer.cdpClick(this.port, cfg.submitText ?? "Sign In", { waitMs: 1200 });

    const now = await this.computer.cdpCurrent(this.port);
    const stillOnLogin = !!now && new URL(now.url).pathname === new URL(loginUrl).pathname;
    if (!submit.ok || stillOnLogin) {
      emit({ type: "login", ok: false, message: `${identity.name}：登入後仍停在登入頁，帳密可能不對` });
      return false;
    }
    emit({ type: "login", ok: true, message: `${identity.name}：登入成功，落在 ${now?.path ?? "?"}` });
    return true;
  }

  /**
   * BFS from the seeds. `onVisit` is awaited for each node so the caller can
   * persist as it goes and keep the crawl resumable / cancellable.
   */
  async crawl(
    identity: CrawlIdentity,
    limits: CrawlLimits,
    emit: (e: CrawlEvent) => void,
    onVisit: (v: VisitResult) => Promise<void>,
    shouldStop: () => boolean,
    screenshot: (routeKey: string) => Promise<string | null>,
  ): Promise<void> {
    const seen = new Set<string>();
    const queue: { url: string; depth: number }[] = [];
    for (const seed of ["/", ...limits.seeds]) {
      const n = normalizeRoute(new URL(seed, this.baseUrl).toString(), this.baseUrl);
      if (n && !seen.has(n.key)) {
        seen.add(n.key);
        queue.push({ url: n.sample, depth: 0 });
      }
    }

    let visited = 0;
    while (queue.length && visited < limits.maxNodes) {
      if (shouldStop()) return;
      const { url, depth } = queue.shift()!;
      const probe = await this.computer.cdpNavigate(this.port, url, 700);
      if (!probe) continue;

      const landed = normalizeRoute(probe.url, this.baseUrl) ?? normalizeRoute(url, this.baseUrl)!;
      const denied = this.looksDenied(probe, landed.key);
      const shot = await screenshot(landed.key);

      const edges: VisitResult["edges"] = [];
      const neighbours: { url: string; key: string }[] = [];
      if (!denied) {
        for (const link of probe.links) {
          const n = normalizeRoute(link.href, this.baseUrl);
          if (!n) continue;
          if (limits.avoid.some((re) => re.test(n.key))) continue;
          edges.push({ toKey: n.key, toSample: n.sample, kind: "link", label: link.text });
          neighbours.push({ url: n.sample, key: n.key });
        }
      }

      await onVisit({
        routeKey: landed.key, sampleUrl: probe.url, probe, depth,
        screenshot: shot, edges, denied,
      });
      visited++;
      emit({ type: "visit", routeKey: landed.key, depth, denied, linkCount: edges.length });

      if (!denied && depth < limits.maxDepth) {
        for (const nb of neighbours) {
          if (!seen.has(nb.key)) {
            seen.add(nb.key);
            queue.push({ url: nb.url, depth: depth + 1 });
          }
        }
      }
    }
  }

  /** A page that redirected to login, or shows an access-denied shell. */
  /** Actively test whether the currently logged-in identity can reach a route.
   *  Used for the cross-identity permission probe: navigate and classify the
   *  landing as granted or denied (a redirect to /login or a 403 page = denied). */
  async checkAccess(url: string, routeKey: string): Promise<{ denied: boolean; probe: PageProbe | null }> {
    const probe = await this.computer.cdpNavigate(this.port, url, 700);
    if (!probe) return { denied: false, probe: null };
    const landed = normalizeRoute(probe.url, this.baseUrl);
    const redirected = !!landed && landed.key !== routeKey;
    return { denied: this.looksDenied(probe, landed?.key ?? routeKey) || redirected, probe };
  }

  private looksDenied(probe: PageProbe, routeKey: string): boolean {
    const landedPath = safePath(probe.url);
    if (/\/login$/.test(landedPath) && !/\/login$/.test(routeKey)) return true;
    const hay = (probe.title + " " + probe.headings.join(" ")).toLowerCase();
    return /(403|forbidden|not authorized|unauthorized|access denied|沒有權限|無權)/.test(hay);
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function firstCredential(creds: Record<string, string>, hints: string[]): string | undefined {
  for (const hint of hints) {
    const key = Object.keys(creds).find((k) => k.toLowerCase().includes(hint));
    if (key) return creds[key];
  }
  // Fall back to the sole credential, if there is exactly one of each kind.
  return undefined;
}

/** Pick the first non-password field as the username input. */
function guessUserField(probe: PageProbe): number | undefined {
  const fields = probe.forms.flatMap((f) => f.fields);
  const idx = fields.findIndex((f) => f.type !== "password" && f.type !== "hidden" && f.type !== "checkbox");
  return idx >= 0 ? idx : undefined;
}
