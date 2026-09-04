import { INestApplication } from "@nestjs/common";
import { api, createApp, loginAdmin, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { LlmProviderError, type LlmProviderAdapter } from "../src/llm/providers";

describe("admin: users, LLM configs, fallback chains, gateway (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    admin = await loginAdmin(app, prisma);
  });
  afterAll(() => app.close());

  it("invites and disables users", async () => {
    const u = await api(app).post("/api/admin/users").set("Cookie", admin).send({ email: "New@Test.local", name: "New" }).expect(201);
    expect(u.body.email).toBe("new@test.local");
    await api(app).post("/api/admin/users").set("Cookie", admin).send({ email: "new@test.local" }).expect(400);
    await api(app).patch(`/api/admin/users/${u.body.id}`).set("Cookie", admin).send({ status: "disabled" }).expect(200);
    const list = await api(app).get("/api/admin/users").set("Cookie", admin).expect(200);
    expect(list.body[0]).toMatchObject({ email: "new@test.local", status: "disabled", teams: [], projects: [] });
  });

  let anthropicId: string, ollamaId: string;

  it("creates LLM configs: key is encrypted, masked on read, execute requires vision", async () => {
    await api(app).post("/api/admin/llm/configs").set("Cookie", admin)
      .send({ name: "bad", provider: "anthropic", model: "m", purposes: ["execute"], supportsVision: false }).expect(400);

    const a = await api(app).post("/api/admin/llm/configs").set("Cookie", admin)
      .send({ name: "Claude", provider: "anthropic", apiKey: "sk-ant-secret-1234", model: "claude-opus-5", purposes: ["discuss", "generate", "execute"], supportsVision: true })
      .expect(201);
    anthropicId = a.body.id;
    expect(a.body).toMatchObject({ hasApiKey: true, apiKeyMasked: "****1234", chainPositions: { discuss: 0, generate: 0, execute: 0 } });
    expect(JSON.stringify(a.body)).not.toContain("sk-ant-secret");
    const row = await prisma.llmConfig.findUniqueOrThrow({ where: { id: anthropicId } });
    expect(row.apiKeyEncrypted).not.toContain("secret");

    const o = await api(app).post("/api/admin/llm/configs").set("Cookie", admin)
      .send({ name: "Local", provider: "ollama", endpoint: "http://localhost:11434", model: "llama3", purposes: ["discuss", "generate"], supportsVision: false })
      .expect(201);
    ollamaId = o.body.id;
    expect(o.body.chainPositions).toEqual({ discuss: 1, generate: 1 });

    const cov = await api(app).get("/api/admin/llm/coverage").set("Cookie", admin).expect(200);
    expect(cov.body).toEqual({ discuss: 2, generate: 2, execute: 1 });
  });

  it("reorders a fallback chain and validates membership", async () => {
    await api(app).put("/api/admin/llm/chains/discuss").set("Cookie", admin).send({ configIds: [ollamaId] }).expect(400); // must include all
    await api(app).put("/api/admin/llm/chains/execute").set("Cookie", admin).send({ configIds: [ollamaId, anthropicId] }).expect(400); // ollama lacks execute
    const r = await api(app).put("/api/admin/llm/chains/discuss").set("Cookie", admin).send({ configIds: [ollamaId, anthropicId] }).expect(200);
    expect(r.body.map((e: any) => e.llmConfigId)).toEqual([ollamaId, anthropicId]);
    const chains = await api(app).get("/api/admin/llm/chains").set("Cookie", admin).expect(200);
    expect(chains.body.discuss.map((e: any) => e.llmConfig.name)).toEqual(["Local", "Claude"]);
    expect(chains.body.generate.map((e: any) => e.llmConfig.name)).toEqual(["Claude", "Local"]);
  });

  it("updating purposes keeps chains in sync; cannot remove the last config of a purpose", async () => {
    // Claude is the only 'execute' config → cannot drop it
    await api(app).patch(`/api/admin/llm/configs/${anthropicId}`).set("Cookie", admin).send({ purposes: ["discuss"] }).expect(400);
    await api(app).patch(`/api/admin/llm/configs/${anthropicId}`).set("Cookie", admin).send({ enabled: false }).expect(400);
    await api(app).delete(`/api/admin/llm/configs/${anthropicId}`).set("Cookie", admin).expect(400);

    // Local can drop 'generate' since Claude still covers it
    const r = await api(app).patch(`/api/admin/llm/configs/${ollamaId}`).set("Cookie", admin).send({ purposes: ["discuss"] }).expect(200);
    expect(r.body.chainPositions).toEqual({ discuss: 0 });
    // api key untouched when not sent; cleared when null
    await api(app).patch(`/api/admin/llm/configs/${anthropicId}`).set("Cookie", admin).send({ name: "Claude 2" }).expect(200)
      .then((res) => expect(res.body.apiKeyMasked).toBe("****1234"));
  });

  it("gateway uses the chain from the DB with retry + fallback and writes call logs", async () => {
    const gateway = app.get(LlmGatewayService);
    const calls: string[] = [];
    const flaky: LlmProviderAdapter = { async complete() { calls.push("ollama"); throw new LlmProviderError("timeout", "slow"); } };
    let n = 0;
    const claude: LlmProviderAdapter = {
      async complete() {
        calls.push("anthropic");
        n++;
        const text = n === 1
          ? '{"schema_version":"1.0","features":[]}' // minItems violation → retry
          : '{"schema_version":"1.0","features":[{"name":"Login","description":"Email + password"}]}';
        return { text, model: "claude-opus-5", usage: { inputTokens: 10, outputTokens: 5 }, nativeJson: true };
      },
    };
    gateway.setProviders({ ollama: flaky, anthropic: claude });

    // discuss chain is [Local, Claude]
    const r = await gateway.structured("discuss", "feature_list", { messages: [{ role: "user", content: "list features" }] });
    expect(calls).toEqual(["ollama", "anthropic", "anthropic"]);
    expect(r.data.features[0].name).toBe("Login");
    expect(r.fallbacks).toBe(1);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["provider_error", "invalid_output", "ok"]);

    const logs = await prisma.llmCallLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.outcome)).toEqual(["timeout", "invalid_output", "ok"]);
    expect(logs[1].rawOutput).toContain('"features":[]');

    const usage = await api(app).get("/api/admin/usage").set("Cookie", admin).expect(200);
    expect(usage.body.recent).toHaveLength(3);
  });

  it("test-prompt endpoint reports latency and errors without throwing", async () => {
    const gateway = app.get(LlmGatewayService);
    gateway.setProviders({ anthropic: { async complete() { return { text: "pong", model: "claude-opus-5", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false }; } } });
    const ok = await api(app).post(`/api/admin/llm/configs/${anthropicId}/test`).set("Cookie", admin).send({ prompt: "ping" }).expect(201);
    expect(ok.body).toMatchObject({ ok: true, text: "pong" });
    expect(typeof ok.body.latencyMs).toBe("number");

    gateway.setProviders({ anthropic: { async complete() { throw new LlmProviderError("auth", "invalid x-api-key", 401); } } });
    const bad = await api(app).post(`/api/admin/llm/configs/${anthropicId}/test`).set("Cookie", admin).send({ prompt: "ping" }).expect(201);
    expect(bad.body).toMatchObject({ ok: false, errorKind: "auth", status: 401 });
  });

  it("sandbox settings and audit log", async () => {
    const s = await api(app).put("/api/admin/sandbox").set("Cookie", admin).send({ maxConcurrent: 3, maxStepsPerCase: 80 }).expect(200);
    expect(s.body).toMatchObject({ maxConcurrent: 3, maxStepsPerCase: 80, resolution: "1280x800" });
    const audit = await api(app).get("/api/admin/audit").set("Cookie", admin).expect(200);
    expect(audit.body.map((a: any) => a.action)).toEqual(expect.arrayContaining(["admin.login", "user.invite", "llm.config.create", "llm.chain.set", "sandbox.update"]));
    // api keys never reach the audit log
    expect(JSON.stringify(audit.body)).not.toContain("sk-ant");
  });
});
