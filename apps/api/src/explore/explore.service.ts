import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  CaseSource, CaseStatus, ExplorationStatus, ObservationKind, Prisma, Priority, Role, type CaseType,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { acquireTargetLock, busyMessage, releaseTargetLock, targetLockHolder } from "../targets/target-lock";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmExhaustedError, LlmGatewayService } from "../llm/llm-gateway.service";
import { LlmHealthService } from "../llm/llm-health.service";
import { AuditService } from "../audit/audit.service";
import { SandboxService } from "../sandbox/sandbox.service";
import { ComputerService, type PageProbe } from "../sandbox/computer.service";
import { EvidenceService } from "../runs/evidence.service";
import { IdentitiesService } from "./identities.service";
import { Crawler, type CrawlIdentity, type CrawlLimits, type VisitResult } from "./crawler";
import { DEFAULT_BREAKPOINTS, rwdIssues, type Breakpoint } from "./rwd";
import { buildMatrix, type PermissionMatrix } from "./permission-matrix";
import { DUPLICATE_THRESHOLD, jaccard, tokenise } from "../generation/generation.service";
import {
  deepContext, DEEP_SYSTEM, permissionContext, SYNTH_SYSTEM, synthesisContext, type NodeForSynthesis,
} from "./explore-prompts";
import { normalizeRoute } from "./route-key";

export type ExploreEvent =
  | { type: "started"; runId: string; target: string; identities: string[] }
  | { type: "phase"; phase: "crawl" | "access" | "rwd" | "synthesis"; message: string }
  | { type: "login"; identity: string; ok: boolean; message: string }
  | { type: "visit"; identity: string; routeKey: string; depth: number; denied: boolean; nodes: number }
  | { type: "interact"; identity: string; routeKey: string; opener: string; found: string }
  | { type: "rwd"; routeKey: string; breakpoint: string; issues: number }
  | { type: "matrix"; routes: number; suspicious: number }
  | { type: "synth"; routeKey: string; cases: number }
  | { type: "paused"; reason: string; message: string }
  | { type: "resumed"; message: string }
  | { type: "error"; message: string }
  | { type: "finished"; runId: string; stats: ExploreStats; durationMs: number };

export interface ExploreConfig {
  maxNodes: number;
  maxDepth: number;
  seeds: string[];
  breakpoints: Breakpoint[];
  doRwd: boolean;
  doSynthesis: boolean;
  /** Model calls the deep-探索 stage may spend (stage E). 0 disables it. */
  deepBudget: number;
  /** Route-key substrings never to follow (logout etc.). */
  avoid: string[];
  /** Click non-destructive buttons to discover modals/menus (interaction probing). */
  doInteract: boolean;
  /** Openers to click per page, and across the whole run. */
  interactPerPage: number;
  interactBudget: number;
  /** Actively test each identity against routes it did not reach (fills the matrix / catches 越權). */
  doAccessProbe: boolean;
  accessProbeBudget: number;
}

export interface ExploreStats {
  identities: number;
  routes: number;
  reachablePairs: number;
  rwdIssues: number;
  findings: number;
  suspiciousAccess: number;
  casesGenerated: number;
  coverage: { crawled: number; withForms: number; synthesized: number };
}

interface ActiveRun {
  runId: string;
  targetId: string;
  events: ExploreEvent[];
  subscribers: Set<(e: ExploreEvent) => void>;
  abort: AbortController;
  /** Remaining run-wide interaction-probe clicks (interaction probing). */
  interactLeft: number;
  /** Identity names whose login failed — surfaced so it is not silently untested. */
  loginFailed: Set<string>;
  /** Project the exploration belongs to, for usage attribution (§4.8). */
  projectId: string | null;
  finished: boolean;
}

const RETAIN_FINISHED_MS = 180_000;
const DEFAULT_AVOID = ["/logout", "/signout", "/sign-out"];

/**
 * Explore-first mode (the user's ask): rather than a person writing a plan, the
 * model opens a sandbox, has the site crawled per identity across breakpoints,
 * and only then designs test cases from what is actually there. The crawl is
 * deterministic (CDP DOM probe + route keys); the model is spent on judgement —
 * deep dives and case design — not on re-deriving the map.
 */
@Injectable()
export class ExploreService implements OnModuleInit {
  private readonly log = new Logger(ExploreService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly health: LlmHealthService,
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
    private readonly evidence: EvidenceService,
    private readonly identities: IdentitiesService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    // A run left mid-flight by a restart cannot resume its in-memory sandbox
    // state, so close it out honestly rather than pretend it is still going.
    const orphans = await this.prisma.explorationRun
      .findMany({ where: { status: { in: [ExplorationStatus.running, ExplorationStatus.paused] } } })
      .catch(() => []);
    for (const run of orphans) {
      await this.prisma.explorationRun
        .update({ where: { id: run.id }, data: { status: ExplorationStatus.failed, error: "API 重新啟動，探索已中斷。", endedAt: new Date() } })
        .then(() => releaseTargetLock(this.prisma, run.targetId))
        .catch(() => undefined);
    }
  }

  async start(targetId: string, userId: string, partial: Partial<ExploreConfig> = {}): Promise<{ runId: string }> {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId } });
    if (target.kind !== "web") throw new BadRequestException("探索模式目前只支援 web 類型的 Target。");
    if (this.active.get(targetId) && !this.active.get(targetId)!.finished) {
      throw new ConflictException("已經有一個探索在進行中。");
    }
    const inFlight = await this.prisma.explorationRun.findFirst({
      where: { targetId, status: { in: [ExplorationStatus.running, ExplorationStatus.paused] } },
    });
    if (inFlight) throw new ConflictException("已經有一個探索在進行中。");

    const url = (target.config as Record<string, unknown>)?.url;
    if (typeof url !== "string" || !url) throw new BadRequestException("這個 Target 沒有設定網址（config.url）。");

    const identities = await this.identities.resolved(targetId);
    if (!identities.length) {
      throw new BadRequestException("請先為這個 Target 建立至少一個身份（可以是未登入的訪客）。");
    }

    const config: ExploreConfig = {
      maxNodes: partial.maxNodes ?? 60,
      maxDepth: partial.maxDepth ?? 4,
      seeds: partial.seeds ?? [],
      breakpoints: partial.breakpoints ?? DEFAULT_BREAKPOINTS,
      doRwd: partial.doRwd ?? true,
      doSynthesis: partial.doSynthesis ?? true,
      deepBudget: partial.deepBudget ?? 8,
      avoid: partial.avoid ?? [],
      doInteract: partial.doInteract ?? true,
      interactPerPage: partial.interactPerPage ?? 8,
      interactBudget: partial.interactBudget ?? 60,
      doAccessProbe: partial.doAccessProbe ?? true,
      accessProbeBudget: partial.accessProbeBudget ?? 150,
    };

    if (!(await acquireTargetLock(this.prisma, targetId))) {
      const holder = await targetLockHolder(this.prisma, targetId);
      throw new ConflictException(`${busyMessage(holder)},無法同時探索。`);
    }
    try {
      const run = await this.prisma.explorationRun.create({
        data: { targetId, config: config as unknown as Prisma.InputJsonValue, triggeredById: userId },
      });
      this.spawn(run.id, targetId, url, config, identities, userId);
      return { runId: run.id };
    } catch (err) {
      await releaseTargetLock(this.prisma, targetId);
      throw err;
    }
  }

  subscribe(targetId: string, sub: (e: ExploreEvent) => void): () => void {
    const run = this.active.get(targetId);
    if (!run) return () => undefined;
    for (const e of run.events) sub(e);
    if (run.finished) return () => undefined;
    run.subscribers.add(sub);
    return () => run.subscribers.delete(sub);
  }

  activeRun(targetId: string) {
    const run = this.active.get(targetId);
    return run ? { runId: run.runId, events: run.events, finished: run.finished } : null;
  }

  async cancel(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const run = this.active.get(targetId);
    if (run) run.abort.abort();
    return { cancelled: !!run };
  }

  private spawn(runId: string, targetId: string, url: string, config: ExploreConfig, identities: CrawlIdentity[], userId: string) {
    const record: ActiveRun = { runId, targetId, events: [], subscribers: new Set(), abort: new AbortController(), interactLeft: 0, loginFailed: new Set(), projectId: null, finished: false };
    this.active.set(targetId, record);
    void this.execute(record, url, config, identities, userId)
      .catch(async (err) => {
        this.log.error(`exploration ${runId} crashed: ${(err as Error).message}`);
        this.publish(record, { type: "error", message: (err as Error).message });
        await this.prisma.explorationRun
          .update({ where: { id: runId }, data: { status: ExplorationStatus.failed, error: String(err).slice(0, 2000), endedAt: new Date() } })
          .catch(() => undefined);
      })
      .finally(() => {
        record.finished = true;
        record.subscribers.clear();
        void releaseTargetLock(this.prisma, targetId);
        const evict = setTimeout(() => {
          if (this.active.get(targetId) === record) this.active.delete(targetId);
        }, RETAIN_FINISHED_MS);
        evict.unref?.();
      });
  }

  private async execute(record: ActiveRun, url: string, config: ExploreConfig, identities: CrawlIdentity[], userId: string) {
    const startedAt = Date.now();
    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: record.targetId }, select: { name: true, projectId: true } });
    record.projectId = target.projectId;
    this.publish(record, { type: "started", runId: record.runId, target: target.name, identities: identities.map((i) => i.name) });

    record.interactLeft = config.doInteract ? config.interactBudget : 0;
    const avoid = [...DEFAULT_AVOID, ...config.avoid].map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const limits: CrawlLimits = { maxNodes: config.maxNodes, maxDepth: config.maxDepth, seeds: config.seeds, avoid };

    // One sandbox for the whole exploration; reset between identities by clearing storage.
    const instance = await this.sandbox.create(userId, { purpose: "run", startUrl: url, ttlMinutes: 60 });
    const port = instance.agentPort!;
    const baseUrl = ensureSlash(url);

    try {
      await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.running } });

      // ---------- stage A + B: crawl per identity ----------
      this.publish(record, { type: "phase", phase: "crawl", message: "逐身份掃描站台結構" });
      const crawler = new Crawler(this.computer, port, baseUrl);
      const privilegedRole = pickPrivileged(identities);

      for (const identity of identities) {
        if (record.abort.signal.aborted) return this.markCancelled(record);
        await this.resetBrowser(port, baseUrl);
        const loggedIn = await crawler.login(identity, (e) => {
          if (e.type === "login") this.publish(record, { type: "login", identity: identity.name, ok: e.ok, message: e.message });
        });
        if (!loggedIn && !identity.isAnonymous) {
          record.loginFailed.add(identity.name); // surfaced on the identity, not silently untested
          continue; // credentials wrong; matrix will show it as untested
        }

        await crawler.crawl(
          identity, limits,
          (e) => {
            if (e.type === "visit") {
              void this.prisma.explorationRun.count(); // keep the connection warm; cheap no-op
            }
          },
          async (visit) => {
            await this.recordVisit(record.runId, identity, visit);
            const nodes = await this.prisma.siteNode.count({ where: { runId: record.runId } });
            this.publish(record, { type: "visit", identity: identity.name, routeKey: visit.routeKey, depth: visit.depth, denied: visit.denied, nodes });
            if (config.doInteract && !visit.denied && record.interactLeft > 0) {
              await this.probeInteractions(record, identity, port, baseUrl, visit, config.interactPerPage);
            }
          },
          () => record.abort.signal.aborted,
          async (routeKey) => this.snap(record.runId, port, identity.id, routeKey),
        );
      }

      // ---------- stage B\': active cross-identity access probing ----------
      // Link-following only tests what each identity can already see. To fill the
      // permission matrix (and actually catch 越權), each identity now actively tries
      // the routes it did not reach; we record granted / denied.
      if (config.doAccessProbe && !record.abort.signal.aborted) {
        this.publish(record, { type: "phase", phase: "access", message: "主動測試各身份的越權存取" });
        await this.probeAccess(record, crawler, port, baseUrl, identities, config.accessProbeBudget);
      }

      // ---------- stage C: RWD ----------
      if (config.doRwd && !record.abort.signal.aborted) {
        this.publish(record, { type: "phase", phase: "rwd", message: "各斷點掃描 RWD" });
        await this.rwdScan(record, port, baseUrl, config, identities, privilegedRole);
      }

      // ---------- stage E: budgeted, read-only deep dives ----------
      if (config.deepBudget > 0 && !record.abort.signal.aborted) {
        await this.deepDive(record, port, baseUrl, identities, privilegedRole, config.deepBudget);
      }

      // ---------- stage B: permission matrix ----------
      const matrix = await this.computeMatrix(record.runId, identities, privilegedRole);
      this.publish(record, { type: "matrix", routes: matrix.rows.length, suspicious: matrix.suspicious.length });

      // ---------- stage E + D: deep dives, then synthesis ----------
      let casesGenerated = 0;
      if (config.doSynthesis && !record.abort.signal.aborted) {
        this.publish(record, { type: "phase", phase: "synthesis", message: "根據掃描結果設計測試案例" });
        casesGenerated = await this.synthesize(record, baseUrl, matrix, userId, config);
      }

      const stats = { ...(await this.computeStats(record.runId, matrix, casesGenerated)), loginFailedIdentities: [...record.loginFailed] };
      await this.prisma.explorationRun.update({
        where: { id: record.runId },
        data: { status: ExplorationStatus.succeeded, stats: stats as unknown as Prisma.InputJsonValue, endedAt: new Date() },
      });
      await this.audit.log("user", userId, "explore.run", record.targetId, { runId: record.runId, ...stats });
      this.publish(record, { type: "finished", runId: record.runId, stats, durationMs: Date.now() - startedAt });
    } finally {
      await this.sandbox.remove(instance.id).catch(() => undefined);
    }
  }

  // ---------- crawl persistence ----------

  /** Stage B': each identity actively visits routes it did not reach during its own
   *  crawl, so the permission matrix has real granted/denied data instead of gaps. */
  private async probeAccess(record: ActiveRun, crawler: Crawler, port: number, baseUrl: string, identities: CrawlIdentity[], budget: number) {
    const nodes = await this.prisma.siteNode.findMany({
      where: { runId: record.runId, kind: { in: ["page", "form"] } },
      select: { id: true, routeKey: true, sampleUrl: true, reachableBy: true, deniedFor: true },
    });
    if (!nodes.length) return;
    let left = budget;
    for (const identity of identities) {
      if (record.abort.signal.aborted || left <= 0) break;
      await this.resetBrowser(port, baseUrl);
      const ok = await crawler.login(identity, (e) => {
        if (e.type === "login") this.publish(record, { type: "login", identity: identity.name, ok: e.ok, message: e.message });
      });
      if (!ok && !identity.isAnonymous) continue;
      for (const node of nodes) {
        if (record.abort.signal.aborted || left <= 0) break;
        // Skip routes we already know this identity can / cannot reach.
        if (node.reachableBy.includes(identity.role) || node.deniedFor.includes(identity.role)) continue;
        left--;
        const { denied, probe } = await crawler.checkAccess(node.sampleUrl, node.routeKey);
        if (!probe) continue; // could not load; leave untested rather than guess
        const reachable = new Set(node.reachableBy);
        const den = new Set(node.deniedFor);
        if (denied) den.add(identity.role); else reachable.add(identity.role);
        node.reachableBy = [...reachable];
        node.deniedFor = [...den];
        await this.prisma.siteNode.update({ where: { id: node.id }, data: { reachableBy: node.reachableBy, deniedFor: node.deniedFor } });
        await this.prisma.siteObservation.create({
          data: {
            runId: record.runId, nodeId: node.id, identityId: identity.id,
            kind: denied ? ObservationKind.access_denied : ObservationKind.page_snapshot,
            data: probeToJson(probe) as Prisma.InputJsonValue,
            note: denied ? `${identity.name} 被擋在 ${node.routeKey}(主動測試)` : `${identity.name} 可存取 ${node.routeKey}(主動測試)`,
          },
        });
        this.publish(record, { type: "visit", identity: identity.name, routeKey: node.routeKey, depth: 0, denied, nodes: await this.prisma.siteNode.count({ where: { runId: record.runId } }) });
      }
    }
  }

  private async recordVisit(runId: string, identity: CrawlIdentity, visit: VisitResult) {
    const node = await this.upsertNode(runId, visit.routeKey, visit.sampleUrl, visit.probe.title, visit.depth);
    // Merge this identity's access into the node.
    const reachable = new Set(node.reachableBy);
    const denied = new Set(node.deniedFor);
    if (visit.denied) denied.add(identity.role);
    else reachable.add(identity.role);
    await this.prisma.siteNode.update({
      where: { id: node.id },
      data: { reachableBy: [...reachable], deniedFor: [...denied], kind: visit.probe.forms.length ? "form" : "page" },
    });

    await this.prisma.siteObservation.create({
      data: {
        runId, nodeId: node.id, identityId: identity.id,
        kind: visit.denied ? ObservationKind.access_denied : ObservationKind.page_snapshot,
        data: probeToJson(visit.probe) as Prisma.InputJsonValue,
        screenshotKey: visit.screenshot,
        note: visit.denied ? `${identity.name} 被擋在 ${visit.routeKey}` : "",
      },
    });

    // Edges (dedupe by from+to+label within the run).
    for (const edge of visit.edges) {
      const to = await this.upsertNode(runId, edge.toKey, edge.toSample, "", visit.depth + 1);
      await this.prisma.siteEdge.create({
        data: { runId, fromId: node.id, toId: to.id, kind: edge.kind, label: edge.label.slice(0, 200) },
      }).catch(() => undefined);
    }
  }

  private async upsertNode(runId: string, routeKey: string, sampleUrl: string, title: string, depth: number) {
    // Fill a title once we have one; keep the first-seen (shallowest) depth by
    // simply not touching it on update.
    return this.prisma.siteNode.upsert({
      where: { runId_routeKey: { runId, routeKey } },
      create: { runId, routeKey, sampleUrl, title, depth },
      update: title ? { title } : {},
    });
  }

  private async snap(runId: string, port: number, identityId: string, routeKey: string): Promise<string | null> {
    const shot = await this.computer.screenshot(port);
    if (!shot.ok || !shot.image) return null;
    const safe = routeKey.replace(/[^a-z0-9]/gi, "_").slice(0, 60) || "root";
    const stored = await this.evidence.put(`explore/${runId}/${identityId}/${safe}.png`, Buffer.from(shot.image, "base64"), "image/png");
    return stored?.key ?? null;
  }


  // ---------- interaction probing (click openers → discover modals/menus) ----------

  /** Buttons we must never click: they finalize or destroy rather than reveal. */
  private static readonly DESTRUCTIVE =
    /(刪除|移除|清除|delete|remove|登出|logout|sign\s*out|確認|confirm|送出|submit|儲存|save|新增至|付款|pay|purchase|下單|結帳|checkout|停用|封存|archive|重設|reset|登入|sign\s*in|log\s*in)/i;
  /** Buttons worth clicking: they tend to open a dialog, drawer, menu or panel. */
  private static readonly OPENER =
    /(新增|建立|add|create|new|編輯|edit|檢視|查看|view|詳情|detail|設定|manage|篩選|filter|展開|more|更多|選單|menu|選擇|invite|邀請|分享|share|匯入|import|匯出|export|開啟|open)/i;

  /**
   * Click the non-destructive controls on a page and see what opens. A modal or
   * menu is not a URL, so the link-following crawl never sees it — this is where
   * "click 新增使用者 → a form pops up" gets discovered. Strictly read-only: we
   * open the thing and record its fields, but never click its submit; and we
   * always close it (Escape → Cancel/Close → re-navigate) before the next one.
   */
  private async probeInteractions(
    record: ActiveRun,
    identity: CrawlIdentity,
    port: number,
    baseUrl: string,
    visit: VisitResult,
    perPage: number,
  ) {
    const base = visit.probe;
    const baseFormSig = new Set(base.forms.map(formSig));
    const openers = base.controls
      .filter((c) => !c.disabled && c.text && ExploreService.OPENER.test(c.text) && !ExploreService.DESTRUCTIVE.test(c.text))
      .slice(0, perPage);
    if (!openers.length) return;

    const pageNode = await this.prisma.siteNode.findUnique({
      where: { runId_routeKey: { runId: record.runId, routeKey: visit.routeKey } },
    });
    if (!pageNode) return;

    const seenHere = new Set<string>();
    for (const opener of openers) {
      if (record.abort.signal.aborted || record.interactLeft <= 0) return;
      if (seenHere.has(opener.text)) continue;
      seenHere.add(opener.text);
      record.interactLeft--;

      const clicked = await this.computer.cdpClick(port, opener.text, { exact: true });
      // A click that navigated is just a link the crawl already handles; go back.
      const cur = await this.computer.cdpCurrent(port);
      const navigated = !!cur && normalizeRoute(cur.url, baseUrl)?.key !== visit.routeKey;
      if (!clicked.ok || navigated) {
        if (navigated) await this.computer.cdpNavigate(port, visit.sampleUrl, 500);
        continue;
      }

      const after = await this.computer.domSnapshot(port);
      if (after) {
        const opened =
          after.dialogs > base.dialogs ||
          after.overlay ||
          after.forms.length > base.forms.length ||
          after.forms.some((f) => !baseFormSig.has(formSig(f)));
        if (opened) {
          const kind = after.dialogs > base.dialogs || after.overlay ? "modal" : after.forms.length > base.forms.length ? "panel" : "menu";
          const newForms = after.forms.filter((f) => !baseFormSig.has(formSig(f)));
          const shot = await this.snapNamed(record.runId, port, `modal/${visit.routeKey}/${opener.text}`);
          await this.recordState(record.runId, identity, pageNode.id, visit.routeKey, opener.text, kind, {
            ...after, forms: newForms.length ? newForms : after.forms,
          }, shot);
          this.publish(record, { type: "interact", identity: identity.name, routeKey: visit.routeKey, opener: opener.text, found: kind });
        }
      }

      // Close whatever opened and get back to a known state before the next opener.
      await this.computer.cdpKey(port, "Escape");
      let check = await this.computer.cdpCurrent(port);
      let still = await this.computer.domSnapshot(port);
      if (still && (still.dialogs > base.dialogs || still.overlay)) {
        for (const label of ["取消", "Cancel", "關閉", "Close", "×", "返回"]) {
          const c = await this.computer.cdpClick(port, label, { exact: false });
          if (c.ok) break;
        }
        still = await this.computer.domSnapshot(port);
      }
      const off = check && normalizeRoute(check.url, baseUrl)?.key !== visit.routeKey;
      if (off || (still && (still.dialogs > base.dialogs || still.overlay))) {
        await this.computer.cdpNavigate(port, visit.sampleUrl, 500);
      }
    }
  }

  /** A discovered modal/menu/panel: a child state node hanging off its page. */
  private async recordState(
    runId: string,
    identity: CrawlIdentity,
    pageId: string,
    pageRoute: string,
    opener: string,
    kind: string,
    probe: PageProbe,
    screenshot: string | null,
  ) {
    const routeKey = `${pageRoute} ▸ ${opener}`;
    const node = await this.prisma.siteNode.upsert({
      where: { runId_routeKey: { runId, routeKey } },
      create: {
        runId, routeKey, sampleUrl: probe.url, title: probe.title || opener,
        kind, depth: 99, reachableBy: [identity.role],
      },
      update: { reachableBy: { push: identity.role } },
    });
    await this.prisma.siteObservation.create({
      data: {
        runId, nodeId: node.id, identityId: identity.id, kind: ObservationKind.page_snapshot,
        data: { title: probe.title, headings: probe.headings, forms: probe.forms, controls: probe.controls, opener, stateKind: kind } as Prisma.InputJsonValue,
        screenshotKey: screenshot, note: `${opener} → ${kind}`,
      },
    });
    // The edge from the page to the state it opens.
    await this.prisma.siteEdge.create({
      data: { runId, fromId: pageId, toId: node.id, kind: "control", label: opener.slice(0, 200) },
    }).catch(() => undefined);
  }

  // ---------- stage C ----------

  private async rwdScan(record: ActiveRun, port: number, baseUrl: string, config: ExploreConfig, identities: CrawlIdentity[], privileged: string | null) {
    // Scan the pages the most-privileged identity could reach; that is the widest view.
    const privId = identities.find((i) => i.role === privileged) ?? identities[0];
    const nodes = await this.prisma.siteNode.findMany({
      where: { runId: record.runId, reachableBy: { has: privId.role } },
      orderBy: { depth: "asc" },
      take: 25,
    });
    if (!nodes.length) return;

    await this.resetBrowser(port, baseUrl);
    await new Crawler(this.computer, port, baseUrl).login(privId, () => undefined);

    for (const bp of config.breakpoints) {
      if (record.abort.signal.aborted) return;
      await this.computer.setViewport(port, bp.width, bp.height, bp.mobile);
      for (const node of nodes) {
        if (record.abort.signal.aborted) return;
        const probe = await this.computer.cdpNavigate(port, node.sampleUrl, 500);
        if (!probe) continue;
        const issues = rwdIssues(probe, bp);
        const shot = await this.snapNamed(record.runId, port, `rwd/${bp.name}/${node.routeKey}`);
        for (const issue of issues) {
          await this.prisma.siteObservation.create({
            data: {
              runId: record.runId, nodeId: node.id, kind: ObservationKind.rwd_issue,
              breakpoint: `${bp.width}x${bp.height}`, severity: issue.severity,
              data: { kind: issue.kind } as Prisma.InputJsonValue, screenshotKey: shot, note: issue.detail,
            },
          });
        }
        this.publish(record, { type: "rwd", routeKey: node.routeKey, breakpoint: bp.name, issues: issues.length });
      }
    }
    await this.computer.clearViewport(port);
  }

  private async snapNamed(runId: string, port: number, name: string): Promise<string | null> {
    const shot = await this.computer.screenshot(port);
    if (!shot.ok || !shot.image) return null;
    const safe = name.replace(/[^a-z0-9]/gi, "_").slice(0, 80);
    const stored = await this.evidence.put(`explore/${runId}/${safe}.png`, Buffer.from(shot.image, "base64"), "image/png");
    return stored?.key ?? null;
  }

  /**
   * Stage E. The deterministic crawl sees links; it does not see what a page
   * *does*. This spends a small vision budget looking hard at the pages that
   * carry forms — reading the screenshot and the DOM — to enumerate scenarios
   * and catch visible defects. It is strictly read-only: the prompt forbids
   * submitting anything, and the model is never handed a click action here, so
   * it cannot mutate the target (the destructive-action risk, closed off).
   */
  private async deepDive(record: ActiveRun, port: number, baseUrl: string, identities: CrawlIdentity[], privileged: string | null, budget: number) {
    this.publish(record, { type: "phase", phase: "crawl", message: `深入查看重點頁面（預算 ${budget} 次）` });
    const privId = identities.find((i) => i.role === privileged) ?? identities[0];
    const forms = await this.prisma.siteNode.findMany({
      where: { runId: record.runId, kind: "form", reachableBy: { has: privId.role } },
      orderBy: { depth: "asc" },
      take: budget,
    });
    if (!forms.length) return;

    await this.resetBrowser(port, baseUrl);
    await new Crawler(this.computer, port, baseUrl).login(privId, () => undefined);

    for (const node of forms) {
      if (record.abort.signal.aborted) return;
      const probe = await this.computer.cdpNavigate(port, node.sampleUrl, 600);
      const shot = await this.computer.screenshot(port);
      if (!shot.ok || !shot.image) continue;
      const stored = await this.snapNamed(record.runId, port, `deep/${node.routeKey}`);
      const forDeep = probe
        ? { routeKey: node.routeKey, title: probe.title, forms: probe.forms, controls: probe.controls.map((c) => c.text) }
        : { routeKey: node.routeKey, title: node.title, forms: [] as unknown, controls: [] as string[] };

      const notes = await this.callDeep(record, forDeep, shot.image);
      if (notes === null) return; // cancelled while parked
      if (!notes) continue;

      for (const sc of notes.scenarios) {
        await this.prisma.siteObservation.create({
          data: {
            runId: record.runId, nodeId: node.id, identityId: privId.id, kind: ObservationKind.deep_note,
            severity: sc.risk === "high" ? "major" : sc.risk === "low" ? "info" : "minor",
            data: { rationale: sc.rationale } as Prisma.InputJsonValue,
            screenshotKey: stored, note: sc.title,
          },
        });
      }
      for (const f of notes.findings) {
        await this.prisma.siteObservation.create({
          data: {
            runId: record.runId, nodeId: node.id, identityId: privId.id, kind: ObservationKind.finding,
            severity: f.severity, data: { description: f.description } as Prisma.InputJsonValue,
            screenshotKey: stored, note: f.title,
          },
        });
      }
      this.publish(record, { type: "synth", routeKey: `深入：${node.routeKey}`, cases: notes.scenarios.length });
    }
  }

  /** A deep-look call with a screenshot; parked-and-resumed on exhaustion. */
  private async callDeep(record: ActiveRun, node: { routeKey: string; title: string; forms: unknown; controls: string[] }, screenshot: string) {
    for (;;) {
      if (record.abort.signal.aborted) return null;
      try {
        const res = await this.gateway.structured(
          "execute",
          "exploration_notes",
          {
            system: DEEP_SYSTEM,
            messages: [{ role: "user", content: [
              { type: "text", text: deepContext(node) },
              { type: "image", mediaType: "image/png", base64: screenshot },
            ] }],
            maxTokens: 2048,
            reasoningEffort: "low",
          },
          { requireVision: true, context: { projectId: record.projectId, targetId: record.targetId } },
        );
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { llmCalls: { increment: 1 } } });
        return res.data;
      } catch (err) {
        if (!(err instanceof LlmExhaustedError) || !err.recoverable) {
          this.log.warn(`deep dive call failed: ${(err as Error).message}`);
          return undefined;
        }
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.paused, pausedReason: err.message.slice(0, 500) } });
        this.publish(record, { type: "paused", reason: err.reason, message: `${err.message} 已保留進度。` });
        const ok = await this.health.waitForPurpose("execute", true, record.abort.signal);
        if (!ok) return null;
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.running, pausedReason: null } });
        this.publish(record, { type: "resumed", message: "LLM 已恢復。" });
      }
    }
  }

  // ---------- stage B: matrix ----------

  private async computeMatrix(runId: string, identities: CrawlIdentity[], privileged: string | null): Promise<PermissionMatrix> {
    const nodes = await this.prisma.siteNode.findMany({ where: { runId } });
    const roles = [...new Set(identities.map((i) => i.role))];
    return buildMatrix(
      nodes.map((n) => ({ routeKey: n.routeKey, title: n.title, reachableBy: n.reachableBy, deniedFor: n.deniedFor })),
      roles,
      privileged,
    );
  }

  // ---------- stage D + E: synthesis ----------

  private async synthesize(record: ActiveRun, baseUrl: string, matrix: PermissionMatrix, userId: string, config: ExploreConfig): Promise<number> {
    const targetId = record.targetId;
    const nodes = await this.prisma.siteNode.findMany({
      where: { runId: record.runId },
      include: { observations: { where: { kind: { in: [ObservationKind.page_snapshot, ObservationKind.rwd_issue] } } } },
      orderBy: { depth: "asc" },
    });

    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId }, select: { descriptionVersion: true, description: true } });
    const descriptionVersion = target.descriptionVersion;
    // Feed the system's own description (what it does + who the roles are, from the
    // handoff/discussion) into synthesis, so cases reflect purpose and per-role
    // behaviour — not just the page structure that was crawled.
    // Cross-route de-dup: per-route synthesis tends to repeat the same case on
    // sibling pages (user profile vs admin account). Fuzzy-match against everything
    // kept so far (§#2).
    const fingerprints: Set<string>[] = [];
    const dedupe = (cases: GeneratedCase[]) => {
      const out: GeneratedCase[] = [];
      for (const c of cases) {
        const t = tokenise(`${c.title} ${c.expected}`);
        if (fingerprints.some((prev) => jaccard(prev, t) >= DUPLICATE_THRESHOLD)) continue;
        fingerprints.push(t);
        out.push(c);
      }
      return out;
    };
    const desc = target.description?.trim();
    const sys = desc
      ? `${SYNTH_SYSTEM}\n\n## 這個系統在做什麼(依描述/交接,可能比掃描更懂它的目的與角色)\n${desc.slice(0, 5000)}\n\n出題時請「結合」系統的目的、各角色實際會做的事,與這個頁面掃到的真實結構——不要只看結構,也要想這個頁面對應到哪個角色的哪個任務。`
      : SYNTH_SYSTEM;
    let total = 0;

    // One synthesis call per reachable, content-bearing route. Small on purpose:
    // a single call over the whole map would blow the gateway's 90s ceiling.
    for (const node of nodes) {
      if (record.abort.signal.aborted) break;
      if (!node.reachableBy.length) continue; // nothing could open it; nothing to test yet
      const snapshot = node.observations.find((o) => o.kind === ObservationKind.page_snapshot);
      const probe = snapshot?.data as unknown as ReturnType<typeof probeToJson> | undefined;
      const rwd = node.observations.filter((o) => o.kind === ObservationKind.rwd_issue).map((o) => o.note);
      // Skip pages with nothing actionable and no access nuance.
      const hasForms = !!probe?.forms?.length;
      if (!hasForms && !rwd.length && node.reachableBy.length && !node.deniedFor.length && node.routeKey !== "/") continue;

      const nodeForSynth: NodeForSynthesis = {
        routeKey: node.routeKey,
        title: node.title,
        headings: probe?.headings ?? [],
        forms: probe?.forms ?? [],
        controls: (probe?.controls ?? []).map((c) => c.text),
        reachableBy: node.reachableBy,
        deniedFor: node.deniedFor,
        rwdIssues: rwd,
      };
      const cases = await this.callSynth(record, sys, synthesisContext(nodeForSynth, baseUrl));
      if (cases === null) return total; // cancelled while parked
      const kept = dedupe(cases);
      total += await this.persistCases(targetId, userId, descriptionVersion, kept, node.routeKey);
      this.publish(record, { type: "synth", routeKey: node.routeKey, cases: kept.length });
    }

    // One dedicated call for cross-identity access, from the matrix.
    if (matrix.rows.length && matrix.identities.length > 1 && !record.abort.signal.aborted) {
      const cases = await this.callSynth(record, sys, permissionContext(matrix, baseUrl));
      if (cases) {
        const kept = dedupe(cases);
        total += await this.persistCases(targetId, userId, descriptionVersion, kept, "權限控制");
        this.publish(record, { type: "synth", routeKey: "權限控制", cases: kept.length });
      }
    }
    return total;
  }

  /** A synthesis call, parked-and-resumed if the LLM is exhausted. Null = cancelled. */
  private async callSynth(record: ActiveRun, system: string, context: string): Promise<GeneratedCase[] | null> {
    for (;;) {
      if (record.abort.signal.aborted) return null;
      try {
        const res = await this.gateway.structured("generate", "test_case", {
          system,
          messages: [{ role: "user", content: context }],
          maxTokens: 8192,
          reasoningEffort: "low",
        }, { context: { projectId: record.projectId, targetId: record.targetId } });
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { llmCalls: { increment: 1 } } });
        return (res.data.cases ?? []) as GeneratedCase[];
      } catch (err) {
        if (!(err instanceof LlmExhaustedError) || !err.recoverable) {
          this.log.warn(`synthesis call failed: ${(err as Error).message}`);
          return []; // one page failing is not the whole run
        }
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.paused, pausedReason: err.message.slice(0, 500) } });
        this.publish(record, { type: "paused", reason: err.reason, message: `${err.message} 已保留進度，有可用的 LLM 會自動接續。` });
        const ok = await this.health.waitForPurpose("generate", false, record.abort.signal);
        if (!ok) return null;
        await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.running, pausedReason: null } });
        this.publish(record, { type: "resumed", message: "LLM 已恢復，繼續設計案例。" });
      }
    }
  }

  private async persistCases(targetId: string, userId: string, descriptionVersion: number, cases: GeneratedCase[], defaultFeature: string): Promise<number> {
    if (!cases.length) return 0;
    return this.prisma.$transaction(async (tx) => {
      let count = 0;
      let featureOrder = (await tx.feature.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      let caseOrder = (await tx.testCase.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      const featureIds = new Map<string, string>();

      for (const c of cases) {
        const featureName = (c.feature_ref || defaultFeature).trim() || defaultFeature;
        let featureId = featureIds.get(featureName);
        if (!featureId) {
          const row = await tx.feature.upsert({
            where: { targetId_name: { targetId, name: featureName } },
            create: { targetId, name: featureName, basedOnDescriptionVersion: descriptionVersion, order: ++featureOrder },
            update: {},
          });
          featureId = row.id;
          featureIds.set(featureName, featureId);
        }
        const steps = (c.steps ?? []).map((s) => String(s).trim()).filter(Boolean);
        if (!c.title?.trim() || !steps.length || !c.expected?.trim()) continue;
        const created = await tx.testCase.create({
          data: {
            targetId, featureId,
            title: c.title.trim(), precondition: c.precondition?.trim() ?? "",
            steps: steps as Prisma.InputJsonValue, expected: c.expected.trim(),
            priority: (isPriority(c.priority) ? c.priority : "P2") as Priority,
            type: (isType(c.type) ? c.type : "happy") as CaseType,
            source: CaseSource.generated, status: CaseStatus.active,
            order: ++caseOrder, basedOnDescriptionVersion: descriptionVersion, createdById: userId,
          },
        });
        await tx.testCaseVersion.create({
          data: { testCaseId: created.id, version: 1, content: caseSnapshot(created) as Prisma.InputJsonObject, createdBy: userId },
        });
        count++;
      }
      return count;
    }, { timeout: 120_000 });
  }

  // ---------- misc ----------

  private async computeStats(runId: string, matrix: PermissionMatrix, casesGenerated: number): Promise<ExploreStats> {
    const [nodes, observations, identities] = await Promise.all([
      this.prisma.siteNode.findMany({ where: { runId }, select: { reachableBy: true, kind: true } }),
      this.prisma.siteObservation.groupBy({ by: ["kind"], where: { runId }, _count: { _all: true } }),
      this.prisma.siteObservation.findMany({ where: { runId, kind: ObservationKind.page_snapshot }, select: { identityId: true, nodeId: true } }),
    ]);
    const count = (k: ObservationKind) => observations.find((o) => o.kind === k)?._count._all ?? 0;
    const withForms = nodes.filter((n) => n.kind === "form").length;
    return {
      identities: matrix.identities.length,
      routes: nodes.length,
      reachablePairs: new Set(identities.map((o) => `${o.identityId}:${o.nodeId}`)).size,
      rwdIssues: count(ObservationKind.rwd_issue),
      findings: count(ObservationKind.finding) + count(ObservationKind.deep_note),
      suspiciousAccess: matrix.suspicious.length,
      casesGenerated,
      coverage: { crawled: nodes.length, withForms, synthesized: casesGenerated },
    };
  }

  /**
   * Clear cookies and storage so the next identity starts logged out. Without
   * this the admin's session leaks into the guest crawl and the permission
   * matrix reports access nobody actually has.
   */
  private async resetBrowser(port: number, baseUrl: string) {
    // Be on the origin first, so clearing its storage actually targets it.
    await this.computer.cdpNavigate(port, new URL("/", baseUrl).toString(), 300).catch(() => undefined);
    await this.computer.cdpReset(port).catch(() => undefined);
    await this.computer.cdpNavigate(port, new URL("/", baseUrl).toString(), 400).catch(() => undefined);
  }

  private async markCancelled(record: ActiveRun) {
    await this.prisma.explorationRun.update({ where: { id: record.runId }, data: { status: ExplorationStatus.failed, error: "已取消", endedAt: new Date() } });
    this.publish(record, { type: "error", message: "探索已取消。" });
  }

  private publish(record: ActiveRun, event: ExploreEvent) {
    record.events.push(event);
    for (const sub of record.subscribers) {
      try { sub(event); } catch { record.subscribers.delete(sub); }
    }
  }

  runs(targetId: string, userId: string) {
    return this.perms.requireTarget(targetId, userId, Role.viewer).then(() =>
      this.prisma.explorationRun.findMany({ where: { targetId }, orderBy: { startedAt: "desc" }, take: 20 }),
    );
  }
}

interface GeneratedCase {
  feature_ref: string;
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: string;
  type: string;
}

function formSig(f: { method: string; fields: { name: string | null; type: string }[] }): string {
  return `${f.method}|${f.fields.map((x) => `${x.name ?? ""}:${x.type}`).join(",")}`;
}

function probeToJson(probe: PageProbe) {
  return {
    title: probe.title, headings: probe.headings, forms: probe.forms,
    controls: probe.controls, landmarks: probe.landmarks,
  };
}

function caseSnapshot(c: { title: string; precondition: string; steps: Prisma.JsonValue; expected: string; priority: string; type: string; featureId: string | null }) {
  return { title: c.title, precondition: c.precondition, steps: c.steps, expected: c.expected, priority: c.priority, type: c.type, featureId: c.featureId };
}

function isPriority(p: string): boolean {
  return ["P0", "P1", "P2", "P3"].includes(p);
}
function isType(t: string): boolean {
  return ["happy", "edge", "negative", "boundary", "security", "performance"].includes(t);
}

function ensureSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/** The identity whose role reads as most privileged, for matrix comparison. */
function pickPrivileged(identities: CrawlIdentity[]): string | null {
  const admin = identities.find((i) => /admin|owner|root|super/i.test(i.role));
  return admin?.role ?? identities[0]?.role ?? null;
}
