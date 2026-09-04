import { INestApplication } from "@nestjs/common";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import type { LlmProviderAdapter } from "../src/llm/providers";

/**
 * Spec §4.4: the model only ever proposes. Nothing reaches the live test list
 * until a person accepts it, they can accept part of it, and what they accepted
 * is traceable afterwards.
 */
describe("change management (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string;
  let projectId: string, targetId: string;
  let loginFeatureId: string, exportFeatureId: string;
  let loginCaseId: string, otherCaseId: string, exportCaseId: string;

  /** What the "model" returns for the next change_proposal request. */
  let nextProposal: Record<string, unknown>;
  /** Case bodies for the second pass, keyed by the reason the impact pass gave. */
  let nextCases: Record<string, Record<string, unknown>>;
  let detailCalls = 0;

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
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req) {
        // The flow makes two kinds of call: one impact pass, then one body per case.
        if (req.jsonSchema?.name === "test_case") {
          detailCalls++;
          const prompt = String(req.messages.at(-1)?.content ?? "");
          const hit = Object.entries(nextCases).find(([key]) => prompt.includes(key));
          if (!hit) throw new Error(`no stub case body matches:\n${prompt.slice(0, 400)}`);
          return {
            text: JSON.stringify({ schema_version: "1.0", cases: [hit[1]] }),
            model: "stub-case",
            usage: { inputTokens: 1, outputTokens: 1 },
            nativeJson: true,
          };
        }
        return {
          text: JSON.stringify(nextProposal),
          model: "stub-change",
          usage: { inputTokens: 1, outputTokens: 1 },
          nativeJson: true,
        };
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });

    owner = await loginUser(app, "owner@c.local");
    editor = await loginUser(app, "editor@c.local");
    viewer = await loginUser(app, "viewer@c.local");

    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner)
      .send({ teamId: team.body.id, name: "Shop", description: "購物網站\n有登入\n有購物車" }).expect(201);
    projectId = project.body.id;
    for (const [email, role] of [["editor@c.local", "editor"], ["viewer@c.local", "viewer"]] as const) {
      await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email, role }).expect(201);
    }
    const target = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "Shop Web", kind: "web", config: { url: "http://127.0.0.1:1" }, description: "登入用帳號密碼\n購物車可以結帳" })
      .expect(201);
    targetId = target.body.id;
  });

  /** A clean feature/case inventory before each test, so ids are predictable. */
  beforeEach(async () => {
    nextCases = {};
    detailCalls = 0;
    await prisma.testCase.deleteMany({ where: { targetId } });
    await prisma.feature.deleteMany({ where: { targetId } });
    await prisma.changeLog.deleteMany({});
    await prisma.changeProposal.deleteMany({});

    const login = await prisma.feature.create({
      data: { targetId, name: "登入", description: "帳號密碼登入", order: 0 },
    });
    const exportF = await prisma.feature.create({
      data: { targetId, name: "匯出", description: "匯出報表", order: 1 },
    });
    loginFeatureId = login.id;
    exportFeatureId = exportF.id;

    const mk = async (featureId: string, title: string, order: number) => {
      const row = await prisma.testCase.create({
        data: {
          targetId, featureId, title,
          precondition: "已有帳號", steps: ["開啟頁面", "送出"], expected: "成功",
          priority: "P1", type: "happy", order,
        },
      });
      await prisma.testCaseVersion.create({
        data: { testCaseId: row.id, version: 1, content: { title } },
      });
      return row.id;
    };
    loginCaseId = await mk(login.id, "帳密登入成功", 0);
    otherCaseId = await mk(login.id, "密碼錯誤時提示", 1);
    exportCaseId = await mk(exportF.id, "匯出 CSV", 2);
  });

  afterAll(async () => {
    await app.close();
    await closeFetchPool();
  });

  const proposalFor = (over: Partial<Record<string, unknown>> = {}) => ({
    schema_version: "1.0",
    summary: "登入改成 OTP，匯出功能移除",
    description_diff: "（模型自己寫的，會被伺服器算的蓋掉）",
    description_after: "登入改用簡訊 OTP\n購物車可以結帳",
    feature_changes: [],
    test_case_changes: [],
    ...over,
  });

  // ---------- creating ----------

  it("proposes from the discussion entry without touching anything yet", async () => {
    nextProposal = proposalFor({
      feature_changes: [
        { op: "modify", feature_id: loginFeatureId, name: "登入", description: "簡訊 OTP 登入", reason: "登入方式改了" },
      ],
      test_case_changes: [
        { op: "modify", case_id: loginCaseId, feature_ref: "登入", reason: "步驟整個換了" },
        { op: "mark_outdated", case_id: otherCaseId, feature_ref: "登入", reason: "密碼沒了，這條要重想" },
      ],
    });
    nextCases = {
      "步驟整個換了": {
        feature_ref: "登入", title: "OTP 登入成功", precondition: "已有手機號",
        steps: ["輸入手機", "輸入 OTP"], expected: "成功", priority: "P0", type: "happy",
      },
    };

    const res = await api(app).post(`/api/targets/${targetId}/changes/from-discussion`)
      .set("Cookie", editor).send({ note: "登入改成簡訊 OTP 了" }).expect(201);

    expect(res.body.state).toBe("pending");
    expect(res.body.source).toBe("discussion");
    expect(res.body.counts).toMatchObject({ features: 1, cases: 2, unresolved: 0 });

    // The description diff is computed from the stored text, not taken from the model.
    expect(res.body.descriptionDiff).toContain("- 登入用帳號密碼");
    expect(res.body.descriptionDiff).toContain("+ 登入改用簡訊 OTP");
    expect(res.body.descriptionDiff).not.toContain("模型自己寫的");

    // "before" comes from the database, and a modification carries a diff (§4.4).
    const modify = res.body.caseChanges.find((c: { op: string }) => c.op === "modify");
    expect(modify.before.title).toBe("帳密登入成功");
    expect(modify.after.title).toBe("OTP 登入成功");
    expect(modify.diff).toContain("【標題】");
    expect(modify.diff).toContain("+ OTP 登入成功");
    // Only the case that actually changes gets a body written for it.
    expect(detailCalls).toBe(1);

    // Nothing has changed yet.
    const target = await prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.description).toContain("登入用帳號密碼");
    const kase = await prisma.testCase.findUniqueOrThrow({ where: { id: loginCaseId } });
    expect(kase.title).toBe("帳密登入成功");
    expect(kase.currentVersion).toBe(1);
  });

  it("flags items that point at something no longer there instead of guessing", async () => {
    nextProposal = proposalFor({
      feature_changes: [{ op: "remove", feature_id: "00000000-0000-4000-8000-000000000000", reason: "沒了" }],
      test_case_changes: [
        { op: "modify", case_id: "00000000-0000-4000-8000-000000000001", reason: "改一條已經不在的案例" },
        { op: "add", feature_ref: "", reason: "" },
      ],
    });
    const res = await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "亂七八糟的提案" }).expect(201);

    expect(res.body.counts.unresolved).toBe(3);
    for (const item of [...res.body.featureChanges, ...res.body.caseChanges]) {
      expect(item.unresolved).toBeTruthy();
    }

    // An unresolved item cannot be forced through by ticking it.
    const ids = [...res.body.featureChanges, ...res.body.caseChanges].map((i: { id: string }) => i.id);
    await api(app).post(`/api/changes/${res.body.id}/apply`).set("Cookie", editor)
      .send({ items: Object.fromEntries(ids.map((id: string) => [id, true])) })
      .expect(400);
  });

  it("keeps project-scope proposals to the description", async () => {
    nextProposal = proposalFor({
      description_after: "購物網站\n有登入\n有購物車\n新增了推薦清單",
      feature_changes: [{ op: "add", name: "推薦", description: "x", reason: "y" }],
      test_case_changes: [{ op: "add", feature_ref: "推薦", reason: "z" }],
    });
    const res = await api(app).post(`/api/projects/${projectId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "加了推薦清單" }).expect(201);

    expect(res.body.counts).toMatchObject({ features: 0, cases: 0 });
    expect(res.body.hasDescriptionChange).toBe(true);

    await api(app).post(`/api/changes/${res.body.id}/apply`).set("Cookie", editor)
      .send({ description: true }).expect(201);

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.description).toContain("推薦清單");
    expect(project.descriptionVersion).toBe(2);
    const versions = await prisma.projectDescriptionVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.version)).toContain(2);
  });

  it("takes the description the user already wrote for the 分析影響 entry", async () => {
    nextProposal = proposalFor({ description_after: "模型自己想的描述" });
    const res = await api(app).post(`/api/targets/${targetId}/changes/analyze`).set("Cookie", editor)
      .send({ source: "manual", note: "我自己改了描述", proposedDescription: "登入用帳號密碼\n購物車可以結帳\n新增了願望清單" })
      .expect(201);
    expect(res.body.descriptionAfter).toContain("願望清單");
    expect(res.body.descriptionAfter).not.toContain("模型自己想的");
  });

  // ---------- applying ----------

  it("applies only what was accepted and records the rest as rejected", async () => {
    nextProposal = proposalFor({
      feature_changes: [
        { op: "modify", feature_id: loginFeatureId, name: "登入", description: "簡訊 OTP 登入", reason: "改了" },
        { op: "add", name: "願望清單", description: "收藏商品", reason: "新功能" },
      ],
      test_case_changes: [
        { op: "modify", case_id: loginCaseId, feature_ref: "登入", reason: "步驟換了" },
        { op: "mark_outdated", case_id: otherCaseId, feature_ref: "登入", reason: "要重想" },
        { op: "add", feature_ref: "願望清單", reason: "新功能要有 case" },
      ],
    });
    nextCases = {
      "步驟換了": {
        feature_ref: "登入", title: "OTP 登入成功", precondition: "已有手機號",
        steps: ["輸入手機", "輸入 OTP"], expected: "成功", priority: "P0", type: "happy",
      },
      "新功能要有 case": {
        feature_ref: "願望清單", title: "收藏商品", precondition: "已登入",
        steps: ["點愛心"], expected: "出現在清單", priority: "P2", type: "happy",
      },
    };
    const proposal = (await api(app).post(`/api/targets/${targetId}/changes/from-discussion`)
      .set("Cookie", editor).send({ note: "登入改 OTP，加了願望清單" }).expect(201)).body;

    const featureModify = proposal.featureChanges.find((f: { op: string }) => f.op === "modify").id;
    const caseModify = proposal.caseChanges.find((c: { op: string }) => c.op === "modify").id;
    const caseOutdated = proposal.caseChanges.find((c: { op: string }) => c.op === "mark_outdated").id;
    const caseAdd = proposal.caseChanges.find((c: { op: string }) => c.op === "add").id;

    const applied = await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor).send({
      description: true,
      items: { [featureModify]: true, [caseModify]: true, [caseAdd]: true, [caseOutdated]: false },
      // A hand edit before applying (§4.4 手動修改後按套用).
      edits: { [caseModify]: { expected: "看到歡迎訊息" } },
    }).expect(201);

    expect(applied.body.descriptionVersionAfter).toBe(2);

    const target = await prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.description).toContain("簡訊 OTP");

    const modified = await prisma.testCase.findUniqueOrThrow({ where: { id: loginCaseId } });
    expect(modified.title).toBe("OTP 登入成功");
    expect(modified.expected).toBe("看到歡迎訊息"); // the hand edit won
    expect(modified.currentVersion).toBe(2);

    // Rejected item untouched.
    const untouched = await prisma.testCase.findUniqueOrThrow({ where: { id: otherCaseId } });
    expect(untouched.status).toBe("active");
    expect(untouched.currentVersion).toBe(1);

    // Added case, and the feature it needed.
    const added = await prisma.testCase.findFirst({ where: { targetId, title: "收藏商品" }, include: { feature: true } });
    expect(added?.source).toBe("change_proposal");
    expect(added?.feature?.name).toBe("願望清單");

    // The feature-add item itself was not accepted, but the accepted case needed
    // that feature, so it exists — created as a side effect, not from the item.
    const wishlist = await prisma.feature.findFirstOrThrow({ where: { targetId, name: "願望清單" } });
    expect(wishlist.description).toBe(""); // the rejected item's description was not taken
    const login = await prisma.feature.findUniqueOrThrow({ where: { id: loginFeatureId } });
    expect(login.description).toBe("簡訊 OTP 登入");

    // Change log carries the per-item outcome, including what was turned down.
    const log = await prisma.changeLog.findFirstOrThrow({ where: { proposalId: proposal.id } });
    const decisions = log.decisions as { description: boolean; items: Record<string, string> };
    expect(decisions.items[caseOutdated]).toBe("rejected");
    expect(decisions.items[caseModify]).toBe("accepted");
    expect(log.affectedTestCaseIds).toContain(loginCaseId);
    expect(log.affectedTestCaseIds).not.toContain(otherCaseId);

    // The new version of the case points back at the change that produced it.
    const history = await api(app).get(`/api/test-cases/${loginCaseId}/history`).set("Cookie", viewer).expect(200);
    expect(history.body[0].version).toBe(2);
    expect(history.body[0].change.id).toBe(log.id);
    expect(history.body[0].change.summary).toContain("OTP");

    // And the target timeline shows it.
    const timeline = await api(app).get(`/api/targets/${targetId}/change-log`).set("Cookie", viewer).expect(200);
    expect(timeline.body[0]).toMatchObject({ source: "discussion", caseCount: expect.any(Number) });
    expect(timeline.body[0].appliedBy).toContain("editor@c.local");

    // Applying twice is refused.
    await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor)
      .send({ items: { [caseOutdated]: true } }).expect(400);
  });

  it("deprecates a removed feature's cases rather than deleting them", async () => {
    nextProposal = proposalFor({
      description_after: "",
      feature_changes: [{ op: "remove", feature_id: exportFeatureId, reason: "匯出功能拿掉了" }],
      test_case_changes: [],
    });
    const proposal = (await api(app).post(`/api/targets/${targetId}/changes/from-discussion`)
      .set("Cookie", editor).send({ note: "匯出功能移除了" }).expect(201)).body;

    const item = proposal.featureChanges[0];
    expect(item.before.name).toBe("匯出");
    await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor)
      .send({ items: { [item.id]: true } }).expect(201);

    const feature = await prisma.feature.findUniqueOrThrow({ where: { id: exportFeatureId } });
    expect(feature.status).toBe("removed");
    const kase = await prisma.testCase.findUniqueOrThrow({ where: { id: exportCaseId } });
    expect(kase.status).toBe("deprecated");
    expect(kase.currentVersion).toBe(2);
  });

  it("keeps the proposal when one case body cannot be written", async () => {
    nextProposal = proposalFor({
      description_after: "",
      test_case_changes: [
        { op: "modify", case_id: loginCaseId, feature_ref: "登入", reason: "這條寫得出來" },
        { op: "modify", case_id: otherCaseId, feature_ref: "登入", reason: "這條寫不出來" },
      ],
    });
    nextCases = {
      "這條寫得出來": {
        feature_ref: "登入", title: "改好的登入", precondition: "", steps: ["一"], expected: "好",
        priority: "P1", type: "happy",
      },
    };
    const res = await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "一好一壞" }).expect(201);

    const ok = res.body.caseChanges.find((c: { reason: string }) => c.reason === "這條寫得出來");
    const bad = res.body.caseChanges.find((c: { reason: string }) => c.reason === "這條寫不出來");
    expect(ok.after.title).toBe("改好的登入");
    expect(ok.unresolved).toBeUndefined();
    expect(bad.unresolved).toContain("失敗");

    // The good half still applies.
    await api(app).post(`/api/changes/${res.body.id}/apply`).set("Cookie", editor)
      .send({ items: { [ok.id]: true } }).expect(201);
    expect((await prisma.testCase.findUniqueOrThrow({ where: { id: loginCaseId } })).title).toBe("改好的登入");
  });

  it("caps how many case bodies one round writes", async () => {
    nextProposal = proposalFor({
      description_after: "",
      test_case_changes: Array.from({ length: 18 }, (_, i) => ({
        op: "add", feature_ref: "登入", reason: `第 ${i} 條`,
      })),
    });
    nextCases = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `第 ${i} 條`,
        { feature_ref: "登入", title: `新案例 ${i}`, precondition: "", steps: ["一"], expected: "好", priority: "P2", type: "happy" },
      ]),
    );
    const res = await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "一次來 18 條" }).expect(201);

    const written = res.body.caseChanges.filter((c: { after: unknown }) => c.after);
    expect(written).toHaveLength(15);
    expect(detailCalls).toBe(15);
    const deferred = res.body.caseChanges.filter((c: { unresolved?: string }) => c.unresolved);
    expect(deferred).toHaveLength(3);
    expect(deferred[0].unresolved).toContain("套用後再分析一次");
  });

  it("refuses an empty decision set", async () => {
    nextProposal = proposalFor({ description_after: "" });
    const proposal = (await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "沒什麼變" }).expect(201)).body;
    await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor).send({}).expect(400);
  });

  it("can be created during a run but not applied during one", async () => {
    nextProposal = proposalFor({ feature_changes: [], test_case_changes: [] });
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
    try {
      const proposal = (await api(app).post(`/api/targets/${targetId}/changes/from-discussion`)
        .set("Cookie", editor).send({ note: "執行中也要能先記下來" }).expect(201)).body;
      await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor)
        .send({ description: true }).expect(409);
    } finally {
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
    }
  });

  it("lets an editor reject a proposal outright", async () => {
    nextProposal = proposalFor();
    const proposal = (await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "看看" }).expect(201)).body;
    const rejected = await api(app).post(`/api/changes/${proposal.id}/reject`).set("Cookie", editor).expect(201);
    expect(rejected.body.state).toBe("rejected");
    await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", editor).send({ description: true }).expect(400);
  });

  // ---------- permissions ----------

  it("keeps viewers read-only", async () => {
    nextProposal = proposalFor();
    await api(app).post(`/api/targets/${targetId}/changes/analyze`).set("Cookie", viewer).send({ note: "x" }).expect(403);

    const proposal = (await api(app).post(`/api/targets/${targetId}/changes/analyze`)
      .set("Cookie", editor).send({ note: "x" }).expect(201)).body;
    await api(app).get(`/api/changes/${proposal.id}`).set("Cookie", viewer).expect(200);
    await api(app).post(`/api/changes/${proposal.id}/apply`).set("Cookie", viewer).send({ description: true }).expect(403);
    await api(app).post(`/api/changes/${proposal.id}/reject`).set("Cookie", viewer).expect(403);
  });

  // ---------- passive detection ----------

  it("builds a proposal from failures that look like the feature changed", async () => {
    const run = await prisma.testRun.create({
      data: { targetId, triggeredById: (await prisma.user.findFirstOrThrow({ where: { email: "editor@c.local" } })).id, status: "succeeded" },
    });
    await api(app).post(`/api/runs/${run.id}/change-proposal`).set("Cookie", editor).expect(400);

    await prisma.testResult.create({
      data: {
        runId: run.id, testCaseId: exportCaseId, caseVersion: 1, verdict: "fail",
        possiblyChanged: true, llmReasoning: "匯出按鈕整個不見了，頁面上沒有這個入口",
      },
    });
    nextProposal = proposalFor({
      description_after: "",
      feature_changes: [{ op: "remove", feature_id: exportFeatureId, reason: "入口消失" }],
      test_case_changes: [],
    });
    const res = await api(app).post(`/api/runs/${run.id}/change-proposal`).set("Cookie", editor).expect(201);
    expect(res.body.source).toBe("run_detection");
    expect(res.body.originNote).toBe(`run:${run.id}`);
    expect(res.body.featureChanges[0].before.name).toBe("匯出");
  });

  it("turns a finding into a proposal and marks the finding converted", async () => {
    const run = await prisma.testRun.create({
      data: { targetId, triggeredById: (await prisma.user.findFirstOrThrow({ where: { email: "editor@c.local" } })).id, status: "succeeded" },
    });
    const finding = await prisma.runFinding.create({
      data: { runId: run.id, severity: "major", title: "結帳頁多了一個優惠碼欄位", description: "案例沒提到這個欄位" },
    });
    nextProposal = proposalFor({
      description_after: "",
      feature_changes: [{ op: "add", name: "優惠碼", description: "結帳時輸入優惠碼", reason: "新欄位" }],
      test_case_changes: [],
    });
    const res = await api(app).post(`/api/findings/${finding.id}/change-proposal`).set("Cookie", editor).expect(201);
    expect(res.body.source).toBe("finding");
    expect((await prisma.runFinding.findUniqueOrThrow({ where: { id: finding.id } })).status).toBe("converted_to_proposal");
  });
});
