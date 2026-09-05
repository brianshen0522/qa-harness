import { INestApplication } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { LlmProviderError, type LlmProviderAdapter } from "../src/llm/providers";
import { LlmHealthService } from "../src/llm/llm-health.service";

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Todo API", version: "1.0.0" },
  paths: {
    "/auth/login": {
      post: {
        summary: "登入取得 token",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } },
            },
          },
        },
        responses: { "200": {}, "401": {} },
      },
    },
    "/todos": {
      get: {
        summary: "列出待辦",
        parameters: [{ name: "tag", in: "query", required: false }],
        responses: { "200": {}, "401": {} },
      },
    },
  },
};

/** Spec §4.3: discovery → feature inventory → cases per feature → dedupe → persist. */
describe("test case generation and list (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string, outsider: string;
  let projectId: string, targetId: string;
  let schemaServer: Server;
  let schemaUrl: string;
  let port = 0;

  /** Systems the generate stub last saw, so tests can assert prompt injection. */
  let seenSystems: string[] = [];

  /** Deterministic stand-in for the generate model, keyed on which schema is asked for. */
  function stubGenerator(features: string[], casesPerFeature: (name: string) => unknown[]) {
    seenSystems = [];
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req) {
        seenSystems.push(req.system ?? "");
        const asksForFeatures = req.jsonSchema?.name === "feature_list";
        const body = asksForFeatures
          ? { schema_version: "1.0", features: features.map((name) => ({ name, description: `${name} 的說明` })) }
          : {
              schema_version: "1.0",
              cases: casesPerFeature(
                // The last user message names the feature being generated.
                String(req.messages.at(-1)?.content ?? "").match(/現在要出題的功能：(.+)/)?.[1]?.trim() ?? "",
              ),
            };
        return { text: JSON.stringify(body), model: "stub-gen", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: true };
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
  }

  const caseFor = (feature: string, n: number) => ({
    feature_ref: feature,
    title: `${feature} 案例 ${n}`,
    precondition: "已登入",
    steps: [`步驟 ${n}-1`, `步驟 ${n}-2`],
    expected: `${feature} 的預期結果 ${n}`,
    priority: n === 1 ? "P0" : "P2",
    type: n === 1 ? "happy" : n === 2 ? "edge" : "negative",
  });

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    await prisma.llmConfig.create({
      data: {
        name: "stub", provider: "anthropic", model: "stub",
        purposes: ["discuss", "generate", "execute"], supportsVision: true,
        fallbackEntries: { create: [{ purpose: "generate", order: 0 }] },
      },
    });

    owner = await loginUser(app, "owner@g.local");
    editor = await loginUser(app, "editor@g.local");
    viewer = await loginUser(app, "viewer@g.local");
    outsider = await loginUser(app, "outsider@g.local");

    schemaServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OPENAPI));
    });
    await new Promise<void>((r) => schemaServer.listen(0, "127.0.0.1", r));
    schemaUrl = `http://127.0.0.1:${(schemaServer.address() as AddressInfo).port}/openapi.json`;
    // A real port, so a run that parks can be read without blocking supertest.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner)
      .send({ teamId: team.body.id, name: "Todo", description: "待辦 app" }).expect(201);
    projectId = project.body.id;
    for (const [email, role] of [["editor@g.local", "editor"], ["viewer@g.local", "viewer"]] as const) {
      await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email, role }).expect(201);
    }
    const target = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "Todo API", kind: "api", config: { base_url: "http://127.0.0.1:1", openapi_url: schemaUrl }, description: "API 描述" })
      .expect(201);
    targetId = target.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => schemaServer.close(() => r()));
    await app.close();
    await closeFetchPool();
  });

  type Event = Record<string, unknown> & { type: string };

  /**
   * Starts a run and reads its event stream. A run that parks waiting for an LLM
   * never closes the stream, so `until` stops reading at the event we care about.
   */
  async function generate(
    cookie: string,
    mode = "replace",
    opts: { target?: string; until?: (e: Event) => boolean; timeoutMs?: number } = {},
  ) {
    const id = opts.target ?? targetId;
    const done = opts.until ?? ((e: Event) => e.type === "finished" || e.type === "error");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/targets/${id}/generate`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });
      if (res.status !== 200) return { status: res.status, body: await res.json(), events: [] as Event[] };

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const events: Event[] = [];
      let buffer = "";
      outer: while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as Event;
          events.push(event);
          if (done(event)) break outer;
        }
      }
      controller.abort();
      return { status: 200, body: {}, events };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits for the run row to settle into one of the given states. */
  async function runStatus(states: string[], timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await prisma.generationRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
      if (run && states.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 100));
    }
    const run = await prisma.generationRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
    throw new Error(`run never reached ${states.join("/")}; last status was ${run?.status}`);
  }

  it("starts empty and is readable by any member", async () => {
    const r = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
    expect(r.body.counts).toEqual({ features: 0, cases: 0, active: 0, outdated: 0, deprecated: 0 });
    expect(r.body.features).toEqual([]);
    expect(r.body.target).toMatchObject({ kind: "api", locked: false, myRole: "viewer" });
    await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", outsider).expect(404);
  });

  it("viewers cannot generate or edit", async () => {
    const r = await generate(viewer);
    expect(r.status).toBe(403);
    await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer)
      .send({ title: "x", steps: ["a"], expected: "b" }).expect(403);
    await api(app).post(`/api/targets/${targetId}/features`).set("Cookie", viewer).send({ name: "f" }).expect(403);
  });

  describe("the pipeline", () => {
    it("reads the OpenAPI schema, expands each feature, dedupes and saves", async () => {
      stubGenerator(["使用者登入", "待辦清單"], (name) => [
        caseFor(name, 1),
        caseFor(name, 2),
        // An exact repeat that dedupe must drop.
        caseFor(name, 1),
      ]);
      const { status, events } = await generate(editor);
      expect(status).toBe(200);

      const byType = Object.fromEntries(events.map((e) => [e.type, e]));
      expect(byType.started).toMatchObject({ kind: "api", mode: "replace", descriptionVersion: 1 });
      expect(byType.discovery).toMatchObject({ ok: true, source: schemaUrl });
      expect(String(byType.discovery.note)).toMatch(/2 個 endpoint/);
      expect((byType.features as unknown as { features: unknown[] }).features).toHaveLength(2);
      expect(byType.deduped).toMatchObject({ kept: 4, dropped: 2 });
      expect(byType.saved).toMatchObject({ featureCount: 2, caseCount: 4 });
      expect(byType.finished).toMatchObject({ featureCount: 2, caseCount: 4 });

      expect(events.filter((e) => e.type === "feature_started")).toHaveLength(2);
    }, 60_000);

    it("stores the cases grouped by feature, ordered and versioned", async () => {
      const r = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(r.body.counts).toMatchObject({ features: 2, cases: 4, active: 4 });

      const login = r.body.features.find((f: { name: string }) => f.name === "使用者登入");
      expect(login.description).toBe("使用者登入 的說明");
      expect(login.stale).toBe(false);
      expect(login.cases).toHaveLength(2);
      // P0 before P2 (§4.3 step 3 ordering).
      expect(login.cases.map((c: { priority: string }) => c.priority)).toEqual(["P0", "P2"]);
      expect(login.cases[0]).toMatchObject({
        source: "generated", status: "active", currentVersion: 1,
        steps: ["步驟 1-1", "步驟 1-2"], precondition: "已登入",
      });

      const versions = await api(app).get(`/api/test-cases/${login.cases[0].id}/versions`).set("Cookie", viewer).expect(200);
      expect(versions.body).toHaveLength(1);
      expect(versions.body[0]).toMatchObject({ version: 1 });
      expect(versions.body[0].content).toMatchObject({ title: login.cases[0].title });
    });

    it("records the run", async () => {
      const runs = await api(app).get(`/api/targets/${targetId}/generation-runs`).set("Cookie", viewer).expect(200);
      expect(runs.body[0]).toMatchObject({
        status: "succeeded", mode: "replace", featureCount: 2, caseCount: 4,
        duplicatesDropped: 2, model: "stub-gen",
      });
      expect(runs.body[0].discovery).toMatchObject({ ok: true });
    });

    it("replace drops the previously generated cases but keeps manual ones", async () => {
      const manual = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title: "手寫的案例", steps: ["手動步驟"], expected: "手動預期", priority: "P1", type: "edge" })
        .expect(201);
      expect(manual.body.source).toBe("manual");

      stubGenerator(["使用者登入"], (name) => [caseFor(name, 1)]);
      const { events } = await generate(editor, "replace");
      expect(events.find((e) => e.type === "saved")).toMatchObject({ caseCount: 1 });

      const after = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      const titles = [
        ...after.body.features.flatMap((f: { cases: { title: string }[] }) => f.cases.map((c) => c.title)),
        ...after.body.unassigned.map((c: { title: string }) => c.title),
      ];
      expect(titles).toContain("手寫的案例");
      expect(titles).toContain("使用者登入 案例 1");
      expect(titles).not.toContain("待辦清單 案例 1");
    }, 60_000);

    it("append keeps what is there and adds to it", async () => {
      const before = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      stubGenerator(["標籤管理"], (name) => [caseFor(name, 1)]);
      await generate(editor, "append");
      const after = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(after.body.counts.cases).toBe(before.body.counts.cases + 1);
      expect(after.body.features.map((f: { name: string }) => f.name)).toContain("標籤管理");
    }, 60_000);

    it("refuses to run twice at once and refuses while the target is running", async () => {
      await prisma.generationRun.create({
        data: { targetId, mode: "replace", descriptionVersion: 1, triggeredById: "x", status: "running" },
      });
      expect((await generate(editor)).status).toBe(409);
      await prisma.generationRun.updateMany({ where: { targetId, status: "running" }, data: { status: "failed" } });

      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
      expect((await generate(editor)).status).toBe(409);
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
    });

    it("parks the run instead of failing it when no model can serve, then finishes it on recovery", async () => {
      const bad: LlmProviderAdapter = {
        async complete() {
          throw new LlmProviderError("server", "upstream is down", 503);
        },
      };
      app.get(LlmGatewayService).setProviders({ anthropic: bad, openai: bad, ollama: bad });

      const { events } = await generate(editor, "replace", { until: (e) => e.type === "paused" });
      const paused = events.find((e) => e.type === "paused")!;
      expect(paused).toMatchObject({ reason: expect.stringMatching(/all_down|all_failed/) });
      expect(String(paused.message)).toMatch(/自動接續/);

      const parked = await runStatus(["paused"]);
      expect(parked.pausedReason).toBeTruthy();
      expect(parked.endedAt).toBeNull();

      // The breaker has taken the config out; putting it back is what an admin
      // fixing the provider, or the probe loop, would do.
      stubGenerator(["恢復後的功能"], (name) => [caseFor(name, 1)]);
      await app.get(LlmHealthService).resetAfterEdit(
        (await prisma.llmConfig.findFirstOrThrow()).id,
      );

      const finished = await runStatus(["succeeded", "failed"], 30_000);
      expect(finished.status).toBe("succeeded");
      expect(finished.caseCount).toBeGreaterThan(0);
      expect(finished.pausedReason).toBeNull();
    }, 90_000);

    it("keeps the work already done when it parks mid-pipeline", async () => {
      let calls = 0;
      const failsOnSecondFeature: LlmProviderAdapter = {
        async complete(_cfg, req) {
          calls++;
          if (req.jsonSchema?.name === "test_case" && calls > 2) {
            throw new LlmProviderError("server", "upstream is down", 503);
          }
          const isFeatures = req.jsonSchema?.name === "feature_list";
          const body = isFeatures
            ? { schema_version: "1.0", features: [{ name: "甲", description: "d" }, { name: "乙", description: "d" }] }
            : { schema_version: "1.0", cases: [caseFor("甲", 1)] };
          return { text: JSON.stringify(body), model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: true };
        },
      };
      await app.get(LlmHealthService).resetAfterEdit((await prisma.llmConfig.findFirstOrThrow()).id);
      app.get(LlmGatewayService).setProviders({ anthropic: failsOnSecondFeature, openai: failsOnSecondFeature, ollama: failsOnSecondFeature });

      await generate(editor, "replace", { until: (e) => e.type === "paused" });
      const parked = await runStatus(["paused"]);
      const progress = parked.progress as unknown as { features: unknown[]; featureIndex: number; cases: unknown[] };
      expect(progress.features).toHaveLength(2);
      expect(progress.featureIndex).toBe(1); // the first feature is done
      expect(progress.cases.length).toBeGreaterThan(0);

      stubGenerator(["甲", "乙"], (name) => [caseFor(name, 1)]);
      await app.get(LlmHealthService).resetAfterEdit((await prisma.llmConfig.findFirstOrThrow()).id);
      const finished = await runStatus(["succeeded", "failed"], 30_000);
      expect(finished.status).toBe("succeeded");
    }, 90_000);
  });

  describe("editing the list", () => {
    let caseId: string;
    let featureId: string;

    it("creates a case and a feature by hand", async () => {
      const feature = await api(app).post(`/api/targets/${targetId}/features`).set("Cookie", editor)
        .send({ name: "手動功能", description: "手動加的" }).expect(201);
      featureId = feature.body.id;
      await api(app).post(`/api/targets/${targetId}/features`).set("Cookie", editor).send({ name: "手動功能" }).expect(400);

      const created = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title: "新案例", precondition: "前置", steps: ["一", "二"], expected: "預期", priority: "P1", type: "negative", featureId })
        .expect(201);
      caseId = created.body.id;
      expect(created.body).toMatchObject({ source: "manual", status: "active", currentVersion: 1, featureId });
    });

    it("rejects a case with no title, no steps or no expected result", async () => {
      for (const body of [
        { title: "", steps: ["a"], expected: "b" },
        { title: "t", steps: ["   "], expected: "b" },
        { title: "t", steps: ["a"], expected: "" },
      ]) {
        await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor).send(body).expect(400);
      }
    });

    it("each edit writes a new version", async () => {
      const first = await api(app).patch(`/api/test-cases/${caseId}`).set("Cookie", editor)
        .send({ title: "改過的標題", steps: ["一", "二", "三"] }).expect(200);
      expect(first.body.currentVersion).toBe(2);

      await api(app).patch(`/api/test-cases/${caseId}`).set("Cookie", editor).send({ priority: "P0" }).expect(200);

      const versions = await api(app).get(`/api/test-cases/${caseId}/versions`).set("Cookie", viewer).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
      expect(versions.body.at(-1).content).toMatchObject({ title: "新案例" });
      expect(versions.body[0].content).toMatchObject({ title: "改過的標題", priority: "P0" });
    });

    it("marks cases outdated in bulk and counts them", async () => {
      const r = await api(app).put(`/api/targets/${targetId}/test-cases/status`).set("Cookie", editor)
        .send({ caseIds: [caseId], status: "outdated" }).expect(200);
      expect(r.body).toEqual({ count: 1 });
      const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(list.body.counts.outdated).toBe(1);
    });

    it("reorders cases and refuses ids from another target", async () => {
      const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      const ids = [
        ...list.body.features.flatMap((f: { cases: { id: string }[] }) => f.cases.map((c) => c.id)),
        ...list.body.unassigned.map((c: { id: string }) => c.id),
      ];
      await api(app).put(`/api/targets/${targetId}/test-cases/order`).set("Cookie", editor)
        .send({ caseIds: [...ids].reverse() }).expect(200);
      await api(app).put(`/api/targets/${targetId}/test-cases/order`).set("Cookie", editor)
        .send({ caseIds: ["11111111-1111-4111-8111-111111111111"] }).expect(400);
    });

    it("deleting a feature keeps its cases, which become unassigned", async () => {
      await api(app).delete(`/api/features/${featureId}`).set("Cookie", editor).expect(200);
      const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(list.body.unassigned.map((c: { id: string }) => c.id)).toContain(caseId);
    });

    it("deletes a case", async () => {
      await api(app).delete(`/api/test-cases/${caseId}`).set("Cookie", editor).expect(200);
      await api(app).get(`/api/test-cases/${caseId}/versions`).set("Cookie", viewer).expect(404);
    });

    it("does not lock the list for a target flag with no run behind it", async () => {
      // §4.5 locks per case against the live run queue, so a stale `running`
      // flag with no run must not freeze editing.
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
      try {
        const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
        expect(list.body.target).toMatchObject({ locked: false, running: false, activeRunId: null });
        const created = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
          .send({ title: "仍然可以新增", steps: ["a"], expected: "b" }).expect(201);
        await api(app).delete(`/api/test-cases/${created.body.id}`).set("Cookie", editor).expect(200);
      } finally {
        await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
      }
    });

    it("blocks only the case being executed while a run is going", async () => {
      const run = await prisma.testRun.create({
        data: { targetId, status: "running", triggeredById: "someone" },
      });
      const [first, second] = await prisma.testCase.findMany({ where: { targetId }, take: 2 });
      await prisma.runCaseQueue.createMany({
        data: [
          { runId: run.id, testCaseId: first.id, status: "running", order: 0 },
          { runId: run.id, testCaseId: second.id, status: "queued", order: 1 },
        ],
      });
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
      try {
        const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
        expect(list.body.target).toMatchObject({ running: true, activeRunId: run.id });
        const all = [...list.body.features.flatMap((f: { cases: unknown[] }) => f.cases), ...list.body.unassigned];
        const locked = all.find((c: { id: string }) => c.id === first.id);
        const queued = all.find((c: { id: string }) => c.id === second.id);
        expect(locked).toMatchObject({ locked: true, runStatus: "running" });
        expect(queued).toMatchObject({ locked: false, runStatus: "queued" });

        await api(app).patch(`/api/test-cases/${first.id}`).set("Cookie", editor).send({ title: "不該改得動" }).expect(409);
        await api(app).patch(`/api/test-cases/${second.id}`).set("Cookie", editor).send({ title: "排隊中可以改" }).expect(200);
      } finally {
        await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
        await prisma.testRun.delete({ where: { id: run.id } });
      }
    });
  });

  it("marks features stale once the description moves on", async () => {
    await api(app).put(`/api/targets/${targetId}/description`).set("Cookie", editor).send({ content: "新的描述" }).expect(200);
    const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
    expect(list.body.features.every((f: { stale: boolean }) => f.stale)).toBe(true);
  });

  it("falls back gracefully when there is no schema to discover", async () => {
    const plain = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "No schema", kind: "api", config: { base_url: "http://127.0.0.1:1" }, description: "只有描述" })
      .expect(201);
    stubGenerator(["只有描述的功能"], (name) => [caseFor(name, 1)]);
    const { events } = await generate(owner, "replace", { target: plain.body.id });
    expect(events.find((e) => e.type === "discovery")).toMatchObject({ ok: false });
    expect(String(events.find((e) => e.type === "discovery")!.note)).toMatch(/openapi_url/);
    expect(events.at(-1)).toMatchObject({ type: "finished", caseCount: 1 });
  }, 60_000);

  it("writes an audit trail for generation and edits", async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["generation.run", "testcase.create", "testcase.update", "testcase.delete", "feature.delete"]));
  });

  it("attributes its LLM calls to the target's project (§4.8 每專案成本)", async () => {
    // Scoped to this target so accumulated logs from earlier cases don't confound it.
    const before = await prisma.llmCallLog.count({ where: { projectId, targetId } });
    stubGenerator(["登入"], () => [caseFor("登入", 1)]);
    const res = await generate(owner, "replace");
    expect(res.events.at(-1)?.type).toBe("finished");
    const after = await prisma.llmCallLog.count({ where: { projectId, targetId } });
    expect(after).toBeGreaterThan(before); // this run's calls are attributed to its project + target
  });

  it("folds enabled global skills into the generation prompt (§4.8)", async () => {
    const skill = await prisma.skill.create({
      data: { scope: "global", name: "日期格式", content: "日期一律 YYYY-MM-DD。", enabled: true, order: 0 },
    });
    const off = await prisma.skill.create({
      data: { scope: "global", name: "停用的", content: "不該出現的內容ZZZ。", enabled: false, order: 1 },
    });
    try {
      stubGenerator(["登入"], () => [caseFor("登入", 1)]);
      const res = await generate(owner, "replace");
      expect(res.events.at(-1)?.type).toBe("finished");
      // Every generate call's system prompt carried the enabled skill, not the disabled one.
      expect(seenSystems.some((sys) => sys.includes("日期一律 YYYY-MM-DD"))).toBe(true);
      expect(seenSystems.every((sys) => !sys.includes("不該出現的內容ZZZ"))).toBe(true);
    } finally {
      await prisma.skill.deleteMany({ where: { id: { in: [skill.id, off.id] } } });
    }
  });

  /** §4.4: after a change is applied, only the features it touched are redone. */
  it("regenerates just the features it was given", async () => {
    stubGenerator(["登入", "購物車"], (name) => [caseFor(name, 1), caseFor(name, 2)]);
    const first = await generate(owner, "replace");
    expect(first.events.at(-1)?.type).toBe("finished");

    const cart = await prisma.feature.findFirstOrThrow({ where: { targetId, name: "購物車" } });
    const loginCases = await prisma.testCase.findMany({
      where: { targetId, feature: { name: "登入" } },
      select: { id: true },
    });

    // The model now answers with different cases; only 購物車 should change.
    stubGenerator(["購物車"], (name) => [caseFor(`${name}改版`, 9)]);
    const second = await fetch(`http://127.0.0.1:${port}/api/targets/${targetId}/generate`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ mode: "append", onlyFeatureIds: [cart.id] }),
    });
    await second.text(); // drain the stream so the run completes

    const after = await prisma.testCase.findMany({
      where: { targetId },
      include: { feature: { select: { name: true } } },
    });
    // Untouched feature keeps its exact cases.
    expect(after.filter((c) => c.feature?.name === "登入").map((c) => c.id).sort())
      .toEqual(loginCases.map((c) => c.id).sort());
    // The regenerated feature was replaced, not appended to.
    const cartTitles = after.filter((c) => c.feature?.name === "購物車").map((c) => c.title);
    expect(cartTitles).toHaveLength(1);
    expect(cartTitles[0]).toContain("改版");
  });

});
