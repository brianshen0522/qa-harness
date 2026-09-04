import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { api, closeFetchPool, loginUser, resetDb } from "./helpers";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmExceptionFilter } from "../src/llm/llm-exception.filter";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { SandboxService } from "../src/sandbox/sandbox.service";
import { ComputerService, type PageProbe } from "../src/sandbox/computer.service";
import type { LlmProviderAdapter } from "../src/llm/providers";

/**
 * The whole explore pipeline against a fake site, so it runs without Docker.
 * A tiny SPA is modelled: "/" links to /admin and /profile; /admin is admin-only;
 * /profile has a form. The fake ComputerService plays login and CDP navigation.
 */
type Control = { text: string; role: string; disabled: boolean };
const SITE: Record<string, { title: string; links: string[]; forms?: PageProbe["forms"]; controls?: Control[]; adminOnly?: boolean }> = {
  "/": { title: "Home", links: ["/admin", "/profile"] },
  "/admin": { title: "Admin", links: ["/admin/users"], adminOnly: true },
  // The interesting page: a button that opens a modal, plus a destructive one
  // the probe must refuse to click.
  "/admin/users": {
    title: "Users", links: [], adminOnly: true,
    controls: [
      { text: "新增使用者", role: "button", disabled: false },
      { text: "刪除", role: "button", disabled: false },
    ],
  },
  "/profile": { title: "Profile", links: [], forms: [{ action: "/profile", method: "post", fields: [{ name: "email", type: "email", required: true, label: "Email" }] }] },
  "/login": { title: "Login", links: [], forms: [{ action: "/login", method: "post", fields: [{ name: "user", type: "text", required: true, label: "User" }, { name: "pass", type: "password", required: true, label: "Password" }] }] },
};
const BASE = "http://fake.local/";
/** The modal that "新增使用者" opens — a form that is not present until clicked. */
const USER_MODAL_FORM = { action: "/admin/users", method: "post", fields: [
  { name: "username", type: "text", required: true, label: "Username" },
  { name: "role", type: "select", required: true, label: "Role" },
] };

function probe(path: string, modalOpen = false): PageProbe {
  const page = SITE[path] ?? SITE["/login"];
  const forms = [...(page.forms ?? [])];
  if (modalOpen && path === "/admin/users") forms.push(USER_MODAL_FORM);
  return {
    url: BASE.replace(/\/$/, "") + path, path, title: page.title,
    headings: [page.title], links: page.links.map((h) => ({ href: BASE.replace(/\/$/, "") + h, text: h, visible: true })),
    forms, controls: page.controls ?? [], landmarks: ["main"], scrollWidth: 1280, clientWidth: 1280, textLength: 500,
    dialogs: modalOpen && path === "/admin/users" ? 1 : 0, overlay: false,
  };
}

/** A fake browser: tracks the identity, the current path, and whether a modal is open. */
class FakeComputer {
  loggedInAsAdmin = false;
  current = "/login";
  modalOpen = false;
  clicks: string[] = [];
  async health() { return { ok: true, width: 1280, height: 800 }; }
  async cdpReset() { this.loggedInAsAdmin = false; this.modalOpen = false; return { ok: true, action: "cdp_reset", durationMs: 1, detail: {} }; }
  async cdpNavigate(_p: number, url: string): Promise<PageProbe> {
    const path = new URL(url).pathname.replace(/\/$/, "") || "/";
    this.modalOpen = false; // navigation closes any modal
    const page = SITE[path];
    if (!page || (page.adminOnly && !this.loggedInAsAdmin)) { this.current = "/login"; return probe("/login"); }
    this.current = path; return probe(path);
  }
  async cdpFill() { return { ok: true, action: "cdp_fill", durationMs: 1, detail: {} }; }
  async cdpClick(_p: number, text: string) {
    this.clicks.push(text);
    if (text.toLowerCase().includes("sign")) { this.loggedInAsAdmin = true; this.current = "/admin"; }
    else if (text === "新增使用者" && this.current === "/admin/users") { this.modalOpen = true; }
    else if (["取消", "Cancel", "關閉", "Close"].includes(text)) { this.modalOpen = false; }
    return { ok: true, action: "cdp_click", durationMs: 1, detail: { before: BASE, navigated: false, url: BASE.replace(/\/$/, "") + this.current } };
  }
  async cdpCurrent() { return { url: BASE.replace(/\/$/, "") + this.current, path: this.current, title: "x" }; }
  async cdpKey(_p: number, key = "Escape") { if (key === "Escape") this.modalOpen = false; return { ok: true, action: "cdp_key", durationMs: 1, detail: {} }; }
  async screenshot() { return { ok: true, action: "screenshot", durationMs: 1, image: Buffer.from("png").toString("base64"), detail: {} }; }
  async setViewport() { return { ok: true, action: "set_viewport", durationMs: 1, detail: {} }; }
  async clearViewport() { return { ok: true, action: "clear_viewport", durationMs: 1, detail: {} }; }
  async perform() { return { ok: true, action: "noop", durationMs: 1, detail: {} }; }
  async domSnapshot(_p: number) { return probe(this.current, this.modalOpen); }
}

describe("explore mode (e2e, no docker)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string;
  let targetId: string;
  let synthCall = 0;
  let fakeComputer: FakeComputer;

  beforeAll(async () => {
    fakeComputer = new FakeComputer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ComputerService).useValue(fakeComputer)
      .overrideProvider(SandboxService).useValue({
        create: async () => ({ id: "fake", agentPort: 1, running: true, novncPort: null }),
        remove: async () => ({ ok: true }),
        settings: async () => ({ id: 1, image: "x", cpu: 1, memoryMb: 1, resolution: "1280x800", maxConcurrent: 2, maxStepsPerCase: 60, stepTimeoutSec: 60, retentionDays: 30, recordVideo: false }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new LlmExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    await resetDb(prisma);

    await prisma.llmConfig.create({
      data: {
        name: "stub", provider: "anthropic", model: "stub", supportsVision: true,
        purposes: ["discuss", "generate", "execute"],
        fallbackEntries: { create: [{ purpose: "generate", order: 0 }, { purpose: "execute", order: 0 }] },
      },
    });
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req) {
        if (req.jsonSchema?.name === "exploration_notes") {
          return json({ schema_version: "1.0", scenarios: [{ title: "空 email 應被擋", rationale: "必填", risk: "high" }], findings: [{ severity: "major", title: "表單用 GET 傳密碼", description: "危險" }] });
        }
        synthCall++;
        return json({ schema_version: "1.0", cases: [{ feature_ref: "探索", title: `案例 ${synthCall}`, precondition: "", steps: ["開頁", "操作"], expected: "成功", priority: "P2", type: "happy" }] });
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });

    owner = await loginUser(app, "owner@x.local");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId: team.body.id, name: "P" }).expect(201);
    const target = await api(app).post(`/api/projects/${project.body.id}/targets`).set("Cookie", owner)
      .send({ name: "Fake Web", kind: "web", config: { url: BASE } }).expect(201);
    targetId = target.body.id;
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner).send({ key: "u", value: "admin" }).expect(200);
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner).send({ key: "p", value: "pw" }).expect(200);
  });

  const json = (body: unknown) => ({ text: JSON.stringify(body), model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: true });

  afterAll(async () => { await app.close(); await closeFetchPool(); });

  it("requires at least one identity", async () => {
    await api(app).post(`/api/targets/${targetId}/explore`).set("Cookie", owner).send({}).expect(400);
  });

  it("crawls per identity, builds an honest matrix, and synthesizes cases", async () => {
    await api(app).post(`/api/targets/${targetId}/identities`).set("Cookie", owner)
      .send({ name: "管理員", role: "admin", credentialKeys: ["u", "p"], loginConfig: { loginPath: "/login", userKey: "u", passKey: "p", submitText: "Sign In" } }).expect(201);
    await api(app).post(`/api/targets/${targetId}/identities`).set("Cookie", owner)
      .send({ name: "訪客", role: "guest", isAnonymous: true }).expect(201);

    // Run and drain the SSE stream to completion.
    const res = await api(app).post(`/api/targets/${targetId}/explore`).set("Cookie", owner)
      .send({ maxNodes: 20, maxDepth: 4, doRwd: true, doSynthesis: true, deepBudget: 4 })
      .buffer(true).parse((r, cb) => { let d = ""; r.on("data", (c: Buffer) => (d += c)); r.on("end", () => cb(null, d)); });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"type":"finished"');

    const detail = await api(app).get(`/api/targets/${targetId}/explore/latest`).set("Cookie", owner).expect(200);
    const d = detail.body;
    expect(d.run.status).toBe("succeeded");

    // The admin reached /admin; the guest was bounced and never did.
    const adminNode = d.nodes.find((n: { routeKey: string }) => n.routeKey === "/admin");
    expect(adminNode.reachableBy).toContain("admin");
    expect(adminNode.reachableBy).not.toContain("guest");

    // Matrix: /admin granted to admin, and NOT granted to guest.
    const row = d.matrix.rows.find((r: { routeKey: string }) => r.routeKey === "/admin");
    expect(row.access.admin).toBe("granted");
    expect(row.access.guest).not.toBe("granted");

    // Deep dive produced a finding and scenarios; synthesis produced cases.
    expect(d.observations.some((o: { kind: string }) => o.kind === "finding")).toBe(true);
    expect(d.run.stats.casesGenerated).toBeGreaterThan(0);

    // The cases actually landed in the target's test list.
    const cases = await prisma.testCase.count({ where: { targetId } });
    expect(cases).toBe(d.run.stats.casesGenerated);
  }, 60_000);

  it("does not leak one identity's session into the next", async () => {
    // The guest crawl runs after the admin's; if the reset failed, the guest
    // would have reached /admin. The matrix above already proves it did not,
    // but assert the observation trail directly too.
    const run = await prisma.explorationRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
    const guest = await prisma.targetIdentity.findFirst({ where: { targetId, role: "guest" } });
    const adminNode = await prisma.siteNode.findFirst({ where: { runId: run!.id, routeKey: "/admin" } });
    const guestSawAdmin = await prisma.siteObservation.findFirst({
      where: { runId: run!.id, nodeId: adminNode!.id, identityId: guest!.id, kind: "page_snapshot" },
    });
    expect(guestSawAdmin).toBeNull();
  });

  it("clicks openers to discover a modal, records its fields, and never clicks the destructive button", async () => {
    const run = await prisma.explorationRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
    // The modal opened by 新增使用者 became a child state node under /admin/users.
    const modal = await prisma.siteNode.findFirst({
      where: { runId: run!.id, routeKey: "/admin/users ▸ 新增使用者" },
      include: { observations: true, inEdges: true },
    });
    expect(modal).not.toBeNull();
    expect(modal!.kind).toBe("modal");
    // Its snapshot captured the modal's own form fields (username + role).
    const snap = modal!.observations[0].data as { forms: { fields: { name: string }[] }[] };
    const fieldNames = snap.forms.flatMap((f) => f.fields.map((x) => x.name));
    expect(fieldNames).toEqual(expect.arrayContaining(["username", "role"]));
    // It hangs off the page that opens it, via a control edge.
    const page = await prisma.siteNode.findFirstOrThrow({ where: { runId: run!.id, routeKey: "/admin/users" } });
    expect(modal!.inEdges.some((e) => e.fromId === page.id && e.kind === "control")).toBe(true);

    // The destructive "刪除" button was on the page but must never have been clicked.
    expect(fakeComputer.clicks).toContain("新增使用者");
    expect(fakeComputer.clicks).not.toContain("刪除");
  });

  it("keeps viewers out of starting an exploration (a real member, not a stranger)", async () => {
    const viewer = await loginUser(app, "viewer@x.local");
    const project = await prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId }, select: { projectId: true } });
    await api(app).post(`/api/projects/${project.projectId}/members`).set("Cookie", owner)
      .send({ email: "viewer@x.local", role: "viewer" }).expect(201);
    // A viewer can read identities but cannot launch an exploration.
    await api(app).get(`/api/targets/${targetId}/identities`).set("Cookie", viewer).expect(200);
    await api(app).post(`/api/targets/${targetId}/explore`).set("Cookie", viewer).send({}).expect(403);
    // A stranger with no membership does not even see the target.
    const stranger = await loginUser(app, "stranger@x.local");
    await api(app).post(`/api/targets/${targetId}/explore`).set("Cookie", stranger).send({}).expect(404);
  });
});
