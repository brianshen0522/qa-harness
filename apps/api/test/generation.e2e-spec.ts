import { INestApplication } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { api, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import type { LlmProviderAdapter } from "../src/llm/providers";

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

  /** Deterministic stand-in for the generate model, keyed on which schema is asked for. */
  function stubGenerator(features: string[], casesPerFeature: (name: string) => unknown[]) {
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req) {
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
  });

  /** Runs the SSE generation endpoint and collects its events. */
  async function generate(cookie: string, mode = "replace") {
    const res = await api(app).post(`/api/targets/${targetId}/generate`).set("Cookie", cookie).send({ mode });
    if (res.status !== 200) return { status: res.status, body: res.body, events: [] as Record<string, unknown>[] };
    const events = res.text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    return { status: res.status, body: res.body, events };
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
      expect((byType.features as { features: unknown[] }).features).toHaveLength(2);
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

    it("reports a failed run instead of leaving it running", async () => {
      const bad: LlmProviderAdapter = {
        async complete() {
          return { text: "not json", model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false };
        },
      };
      app.get(LlmGatewayService).setProviders({ anthropic: bad, openai: bad, ollama: bad });
      const { events } = await generate(editor);
      expect(events.at(-1)).toMatchObject({ type: "error" });

      const runs = await api(app).get(`/api/targets/${targetId}/generation-runs`).set("Cookie", viewer).expect(200);
      expect(runs.body[0]).toMatchObject({ status: "failed" });
      expect(runs.body[0].error).toBeTruthy();
    }, 60_000);
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

    it("locks the whole list while the target is running", async () => {
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
      const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(list.body.target.locked).toBe(true);
      await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title: "t", steps: ["a"], expected: "b" }).expect(409);
      await api(app).post(`/api/targets/${targetId}/features`).set("Cookie", editor).send({ name: "x" }).expect(409);
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
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
    const res = await api(app).post(`/api/targets/${plain.body.id}/generate`).set("Cookie", owner).send({}).expect(200);
    const events = res.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    expect(events.find((e) => e.type === "discovery")).toMatchObject({ ok: false });
    expect(String(events.find((e) => e.type === "discovery").note)).toMatch(/openapi_url/);
    expect(events.at(-1)).toMatchObject({ type: "finished", caseCount: 1 });
  }, 60_000);

  it("writes an audit trail for generation and edits", async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["generation.run", "testcase.create", "testcase.update", "testcase.delete", "feature.delete"]));
  });
});
