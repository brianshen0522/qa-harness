import { INestApplication } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { api, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import type { LlmProviderAdapter, LlmRequest } from "../src/llm/providers";

/** Spec §4.1: guided discussion, completeness panel, draft, target proposals. */
describe("discussion area (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string;
  let projectId: string, targetId: string;
  let pageServer: Server;
  let pageUrl: string;
  let seen: LlmRequest[] = [];

  /** Deterministic stand-in for the discuss model. */
  function stubTurn(turn: Record<string, unknown>) {
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req) {
        seen.push(req);
        return {
          text: JSON.stringify({ schema_version: "1.0", ...turn }),
          model: "stub-discuss",
          usage: { inputTokens: 1, outputTokens: 1 },
          nativeJson: true,
        };
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
  }

  const emptyTurn = {
    message: "了解了。",
    questions: [],
    draft_patch: { mode: "none", content: "" },
    completeness: {},
    target_proposals: [],
  };

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    await prisma.llmConfig.create({
      data: { name: "stub", provider: "anthropic", model: "stub", purposes: ["discuss", "generate"], supportsVision: true,
        fallbackEntries: { create: [{ purpose: "discuss", order: 0 }, { purpose: "generate", order: 0 }] } },
    });

    owner = await loginUser(app, "owner@d.local", "Owner");
    editor = await loginUser(app, "editor@d.local", "Editor");
    viewer = await loginUser(app, "viewer@d.local", "Viewer");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner)
      .send({ teamId: team.body.id, name: "Todo", description: "初版描述" }).expect(201);
    projectId = project.body.id;
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "editor@d.local", role: "editor" }).expect(201);
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "viewer@d.local", role: "viewer" }).expect(201);
    const target = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "Todo API", kind: "api" }).expect(201);
    targetId = target.body.id;

    pageServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Todo Docs</title></head><body><h1>API</h1><p>GET /todos 回傳清單</p></body></html>");
    });
    await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", r));
    pageUrl = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}/docs`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => pageServer.close(() => r()));
    await app.close();
  });

  beforeEach(() => { seen = []; });

  it("creates the thread on first read, seeded from the description, with everything unknown", async () => {
    const r = await api(app).get(`/api/projects/${projectId}/discussion`).set("Cookie", viewer).expect(200);
    expect(r.body.scope).toBe("project");
    expect(r.body.draft).toBe("初版描述");
    expect(r.body.canPropose).toBe(true);
    expect(r.body.checklist.map((c: { key: string }) => c.key)).toEqual(
      ["product_goal", "user_roles", "main_flows", "modules", "tech_stack", "dev_environment", "test_surfaces"],
    );
    expect(new Set(Object.values(r.body.completeness))).toEqual(new Set(["unknown"]));
    expect(r.body.messages).toEqual([]);
  });

  it("viewers cannot talk to the LLM or touch the draft", async () => {
    await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", viewer).send({ content: "hi" }).expect(403);
    await api(app).put(`/api/projects/${projectId}/discussion/draft`).set("Cookie", viewer).send({ draft: "x" }).expect(403);
    await api(app).post(`/api/projects/${projectId}/discussion/save-description`).set("Cookie", viewer).send({}).expect(403);
  });

  it("a turn stores both messages, patches the draft and updates completeness", async () => {
    stubTurn({
      message: "先確認產品目標。",
      questions: [{ item: "product_goal", question: "這個 app 給誰用？" }, { item: "user_roles", question: "有哪些角色？" }],
      draft_patch: { mode: "replace", content: "# Todo App\n\n待辦事項管理。" },
      completeness: { product_goal: "partial", user_roles: "unknown" },
      target_proposals: [],
    });
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor)
      .send({ content: "這是一個待辦 app" }).expect(201);

    expect(r.body.turn.questions).toHaveLength(2);
    expect(r.body.draft).toBe("# Todo App\n\n待辦事項管理。");
    expect(r.body.completeness.product_goal).toBe("partial");
    expect(r.body.completeness.tech_stack).toBe("unknown");
    expect(r.body.llm.model).toBe("stub-discuss");

    // The checklist and current draft are given to the model.
    expect(seen[0].system).toContain("product_goal");
    expect(seen[0].system).toContain("初版描述");

    const after = await api(app).get(`/api/projects/${projectId}/discussion`).set("Cookie", viewer).expect(200);
    expect(after.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(after.body.messages[1].structured.questions[0].item).toBe("product_goal");
  });

  it("append mode adds to the draft instead of replacing it", async () => {
    stubTurn({ ...emptyTurn, draft_patch: { mode: "append", content: "## 技術棧\n\nReact + NestJS" }, completeness: { tech_stack: "clear" } });
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor)
      .send({ content: "前端 React，後端 NestJS" }).expect(201);
    expect(r.body.draft).toBe("# Todo App\n\n待辦事項管理。\n\n## 技術棧\n\nReact + NestJS");
    expect(r.body.completeness.tech_stack).toBe("clear");
    expect(r.body.completeness.product_goal).toBe("partial"); // earlier value survives
  });

  it("replays prior turns to the model as conversation history", async () => {
    stubTurn(emptyTurn);
    await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor).send({ content: "第三則" }).expect(201);
    const msgs = seen[0].messages;
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs[msgs.length - 1].content).toContain("第三則");
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });

  it("fetches URLs in the message, feeds them to the model and files them as attachments", async () => {
    stubTurn(emptyTurn);
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor)
      .send({ content: `文件在這裡 ${pageUrl}` }).expect(201);

    expect(r.body.userMessage.references[0]).toMatchObject({ url: pageUrl, title: "Todo Docs" });
    expect(String(seen[0].messages.at(-1)!.content)).toContain("GET /todos 回傳清單");

    const attachments = await api(app).get(`/api/projects/${projectId}/attachments`).set("Cookie", viewer).expect(200);
    expect(attachments.body[0]).toMatchObject({ sourceType: "url", filename: "Todo Docs", url: pageUrl });
  });

  it("records unreachable URLs without failing the turn", async () => {
    stubTurn(emptyTurn);
    const dead = "http://127.0.0.1:9/nope";
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor)
      .send({ content: `試試 ${dead}` }).expect(201);
    expect(r.body.userMessage.references[0].error).toBeTruthy();
    const attachments = await api(app).get(`/api/projects/${projectId}/attachments`).set("Cookie", viewer).expect(200);
    expect(attachments.body.some((a: { url: string }) => a.url === dead)).toBe(false);
  });

  it("saves the draft as a new description version tagged as coming from the discussion", async () => {
    await api(app).put(`/api/projects/${projectId}/discussion/draft`).set("Cookie", editor)
      .send({ draft: "# Todo App\n\n最終描述" }).expect(200);
    const saved = await api(app).post(`/api/projects/${projectId}/discussion/save-description`).set("Cookie", editor).send({}).expect(201);
    expect(saved.body.description).toBe("# Todo App\n\n最終描述");
    expect(saved.body.descriptionVersion).toBe(2);

    const versions = await api(app).get(`/api/projects/${projectId}/description/versions`).set("Cookie", viewer).expect(200);
    expect(versions.body[0]).toMatchObject({ version: 2, source: "discussion" });
  });

  it("rejects saving an empty draft", async () => {
    await api(app).put(`/api/projects/${projectId}/discussion/draft`).set("Cookie", editor).send({ draft: "   " }).expect(200);
    await api(app).post(`/api/projects/${projectId}/discussion/save-description`).set("Cookie", editor).send({}).expect(400);
    await api(app).put(`/api/projects/${projectId}/discussion/draft`).set("Cookie", editor).send({ draft: "# Todo App" }).expect(200);
  });

  describe("target proposals (§4.1)", () => {
    let proposalId: string;

    it("stores proposals as pending — the LLM never creates a Target", async () => {
      stubTurn({
        ...emptyTurn,
        message: "被測面清楚了，建議建立這個 Target。",
        completeness: { test_surfaces: "clear" },
        target_proposals: [{
          kind: "web", name: "Todo Web", config: { url: "http://localhost:3000", viewport: "1280x800" },
          credential_keys: ["login_password"], rationale: "前端頁面需要 QA",
        }],
      });
      const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor)
        .send({ content: "有一個前端在 localhost:3000" }).expect(201);

      expect(r.body.proposals).toHaveLength(1);
      proposalId = r.body.proposals[0].id;
      expect(r.body.proposals[0]).toMatchObject({ kind: "web", name: "Todo Web", status: "pending", credentialKeys: ["login_password"] });
      const targets = await api(app).get(`/api/projects/${projectId}/targets`).set("Cookie", viewer).expect(200);
      expect(targets.body.map((t: { name: string }) => t.name)).not.toContain("Todo Web");
    });

    it("editors cannot accept a proposal, owners can", async () => {
      await api(app).post(`/api/discussion/proposals/${proposalId}/accept`).set("Cookie", editor).expect(403);
      const r = await api(app).post(`/api/discussion/proposals/${proposalId}/accept`).set("Cookie", owner).expect(201);
      expect(r.body.status).toBe("accepted");
      expect(r.body.target).toMatchObject({ name: "Todo Web", kind: "web" });
      expect(r.body.target.config).toEqual({ url: "http://localhost:3000", viewport: "1280x800" });
      expect(r.body.createdTargetId).toBe(r.body.target.id);
    });

    it("a decided proposal cannot be decided again", async () => {
      await api(app).post(`/api/discussion/proposals/${proposalId}/accept`).set("Cookie", owner).expect(400);
      await api(app).post(`/api/discussion/proposals/${proposalId}/reject`).set("Cookie", owner).expect(400);
    });

    it("editors can reject", async () => {
      stubTurn({ ...emptyTurn, target_proposals: [{ kind: "api", name: "不要的", config: {}, credential_keys: [], rationale: "r" }] });
      const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor).send({ content: "再提一個" }).expect(201);
      const rejected = await api(app).post(`/api/discussion/proposals/${r.body.proposals[0].id}/reject`).set("Cookie", editor).expect(201);
      expect(rejected.body.status).toBe("rejected");
    });
  });

  describe("target-scope discussion", () => {
    it("uses the kind-specific checklist and never proposes targets", async () => {
      const r = await api(app).get(`/api/targets/${targetId}/discussion`).set("Cookie", viewer).expect(200);
      expect(r.body.canPropose).toBe(false);
      expect(r.body.kind).toBe("api");
      expect(r.body.checklist.map((c: { key: string }) => c.key)).toEqual(["endpoints", "auth", "test_accounts", "data_dependencies"]);

      stubTurn({ ...emptyTurn, target_proposals: [{ kind: "api", name: "忽略我", config: {}, credential_keys: [], rationale: "r" }] });
      const posted = await api(app).post(`/api/targets/${targetId}/discussion/messages`).set("Cookie", editor)
        .send({ content: "有 GET /todos" }).expect(201);
      expect(posted.body.proposals).toEqual([]);
      expect(seen[0].system).toContain("一律給空陣列");
    });

    it("is locked while the target is running", async () => {
      await api(app).put(`/api/targets/${targetId}/discussion/draft`).set("Cookie", editor).send({ draft: "描述" }).expect(200);
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
      await api(app).post(`/api/targets/${targetId}/discussion/save-description`).set("Cookie", editor).send({}).expect(409);
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
      await api(app).post(`/api/targets/${targetId}/discussion/save-description`).set("Cookie", editor).send({}).expect(201);
    });
  });

  it("answers 503 with a usable message when no discuss model is configured", async () => {
    await prisma.llmConfig.updateMany({ data: { enabled: false } });
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor).send({ content: "x" }).expect(503);
    expect(r.body.message).toMatch(/No enabled LLM config for purpose 'discuss'/);
    expect(r.body.error).toBe("LLM Unavailable");
    await prisma.llmConfig.updateMany({ data: { enabled: true } });
  });

  it("answers 503 listing each attempt when every model returns invalid output", async () => {
    const bad = { async complete() { return { text: "not json", model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false }; } };
    app.get(LlmGatewayService).setProviders({ anthropic: bad, openai: bad, ollama: bad });
    const r = await api(app).post(`/api/projects/${projectId}/discussion/messages`).set("Cookie", editor).send({ content: "x" }).expect(503);
    expect(r.body.message).toMatch(/discussion_turn/);
    expect(r.body.attempts).toHaveLength(3);
    expect(r.body.attempts.every((a: { outcome: string }) => a.outcome === "invalid_output")).toBe(true);
  });
});
