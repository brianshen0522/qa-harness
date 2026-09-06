import { INestApplication } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { LlmHealthService } from "../src/llm/llm-health.service";
import { LlmProviderError, type LlmProviderAdapter, type LlmRequest } from "../src/llm/providers";
import { RunService } from "../src/runs/run.service";
import { TargetsService } from "../src/targets/targets.service";
import { RetentionService } from "../src/runs/retention.service";

/** Spec §4.5 / §4.6: run a case list, judge each case, keep evidence, stay steerable. */
describe("test runs (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string;
  let projectId: string, targetId: string;
  let caseIds: string[] = [];
  let apiServer: Server;
  let apiBase: string;
  let requests: { method: string; url: string; auth: string | undefined; body: string }[] = [];

  /**
   * Stands in for the execute model. `plan` yields one action per step; once it
   * is exhausted the agent says done, and the verdict call is answered from
   * `verdict`.
   */
  function stubModel(
    plan: (call: number) => Record<string, unknown> | null,
    verdict: Partial<Record<string, unknown>> = {},
  ) {
    requests = [];
    let call = 0;
    const adapter: LlmProviderAdapter = {
      async complete(_cfg, req: LlmRequest) {
        // A fresh case starts with a single message, so the plan restarts for
        // each case rather than counting across the whole run.
        if (req.jsonSchema?.name === "execution_step" && req.messages.length === 1) call = 0;
        if (req.jsonSchema?.name === "case_verdict") {
          return json({
            schema_version: "1.0",
            verdict: "pass",
            reasoning: "依 step-1 的回應判定",
            evidence_refs: ["step-1"],
            repro_steps: [],
            possibly_changed: false,
            ...verdict,
          });
        }
        call++;
        const action = plan(call);
        return json({
          schema_version: "1.0",
          phase: action ? "executing" : "judging",
          observation: `第 ${call} 步的畫面`,
          intent: action ? "執行下一步" : "收工",
          action: action ?? { type: "done", params: { summary: "做完了" } },
        });
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
    return { calls: () => call };
  }

  /** Answers the `test_case` schema, which is what drafting from a finding asks for. */
  function stubCaseWriter(caseBody: Record<string, unknown>) {
    const adapter: LlmProviderAdapter = {
      async complete() {
        return json({ schema_version: "1.0", cases: [caseBody] });
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
  }

  const json = (body: unknown) => ({
    text: JSON.stringify(body),
    model: "stub-exec",
    usage: { inputTokens: 1, outputTokens: 1 },
    nativeJson: true,
  });

  /** Waits for the run row to reach one of the given states. */
  async function waitForRun(states: string[], timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await prisma.testRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
      if (run && states.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 100));
    }
    const run = await prisma.testRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
    throw new Error(`run never reached ${states.join("/")}; last was ${run?.status}`);
  }

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    await prisma.llmConfig.create({
      data: {
        name: "stub", provider: "anthropic", model: "stub",
        purposes: ["discuss", "generate", "execute"], supportsVision: true,
        fallbackEntries: { create: [{ purpose: "execute", order: 0 }, { purpose: "generate", order: 0 }] },
      },
    });

    owner = await loginUser(app, "owner@r.local");
    editor = await loginUser(app, "editor@r.local");
    viewer = await loginUser(app, "viewer@r.local");

    apiServer = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: req.url !== "/missing", path: req.url }));
    });
    await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
    apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner)
      .send({ teamId: team.body.id, name: "P", description: "d" }).expect(201);
    projectId = project.body.id;
    for (const [email, role] of [["editor@r.local", "editor"], ["viewer@r.local", "viewer"]] as const) {
      await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email, role }).expect(201);
    }
    const target = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "API", kind: "api", config: { base_url: apiBase }, description: "測試用 API" }).expect(201);
    targetId = target.body.id;
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner)
      .send({ key: "token", value: "super-secret-token" }).expect(200);

    for (const title of ["第一條", "第二條", "第三條"]) {
      const c = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title, steps: [`做 ${title}`], expected: "應該成功", priority: "P1" }).expect(201);
      caseIds.push(c.body.id);
    }
  });

  afterAll(async () => {
    await new Promise<void>((r) => apiServer.close(() => r()));
    await app.close();
    await closeFetchPool();
  });

  it("viewers cannot start a run", async () => {
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", viewer).send({}).expect(403);
  });

  it("refuses to start with nothing to run", async () => {
    await prisma.testCase.updateMany({ where: { targetId }, data: { status: "deprecated" } });
    const r = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(400);
    expect(r.body.message).toMatch(/沒有狀態為「正常」/);
    await prisma.testCase.updateMany({ where: { targetId }, data: { status: "active" } });
  });

  describe("a straightforward run", () => {
    let runId: string;

    it("executes every case, judges each one and releases the target", async () => {
      stubModel((call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/ok" } } : null));
      const started = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(201);
      runId = started.body.runId;
      expect(started.body.total).toBe(3);

      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("succeeded");
      expect(run.endedAt).not.toBeNull();

      const detail = await api(app).get(`/api/runs/${runId}`).set("Cookie", viewer).expect(200);
      expect(detail.body.verdicts).toMatchObject({ pass: 3, fail: 0 });
      expect(detail.body.cases).toHaveLength(3);
      expect(detail.body.cases.every((c: { queueStatus: string }) => c.queueStatus === "done")).toBe(true);
      // Every case pinned the version it ran against.
      expect(detail.body.cases.every((c: { caseVersion: number }) => c.caseVersion === 1)).toBe(true);

      const target = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
      expect(target.body.status).toBe("idle");

      // Each case really called the target's API, once.
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({ method: "GET", url: "/ok" });
    }, 60_000);

    it("keeps a per-step transcript and http evidence with secrets masked", async () => {
      const steps = await api(app).get(`/api/runs/${runId}/steps`).set("Cookie", viewer).expect(200);
      expect(steps.body).toHaveLength(6); // one action plus one done, per case
      expect(steps.body[0]).toMatchObject({ phase: "executing", modelUsed: "stub-exec" });
      expect(steps.body[0].observation).toContain("畫面");

      const detail = await api(app).get(`/api/runs/${runId}`).set("Cookie", viewer).expect(200);
      const evidence = detail.body.cases[0].result.evidence;
      expect(evidence.httpLogs).toHaveLength(1);
      expect(evidence.httpLogs[0]).toMatchObject({ method: "GET", status: 200 });
      expect(JSON.stringify(detail.body)).not.toContain("super-secret-token");
    });

    it("computes a pass rate per feature", async () => {
      const detail = await api(app).get(`/api/runs/${runId}`).set("Cookie", viewer).expect(200);
      expect(detail.body.features).toEqual([expect.objectContaining({ name: "未分類", pass: 3, total: 3 })]);
    });

    it("lists the run with its verdict tally", async () => {
      const runs = await api(app).get(`/api/targets/${targetId}/runs`).set("Cookie", viewer).expect(200);
      expect(runs.body[0]).toMatchObject({ id: runId, status: "succeeded" });
      expect(runs.body[0].verdicts).toMatchObject({ pass: 3 });
    });
  });

  it("records a failure with repro steps and the possibly-changed flag", async () => {
    stubModel(
      (call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/missing" } } : null),
      { verdict: "fail", repro_steps: ["呼叫 GET /missing"], possibly_changed: true, reasoning: "endpoint 不存在" },
    );
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);

    const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
    const result = detail.body.cases[0].result;
    expect(result).toMatchObject({ verdict: "fail", possiblyChanged: true });
    expect(result.reproSteps).toEqual(["呼叫 GET /missing"]);
  }, 60_000);

  it("answers a question about a QA result, grounded in the run's evidence (§4.7)", async () => {
    // Seed a finished run with a failed result + a step, deterministically.
    const run = await prisma.testRun.create({ data: { targetId, status: "failed", triggeredById: (await prisma.user.findFirstOrThrow({ where: { email: "editor@r.local" } })).id, endedAt: new Date() } });
    const result = await prisma.testResult.create({
      data: { runId: run.id, testCaseId: caseIds[0], caseVersion: 1, verdict: "fail", llmReasoning: "endpoint 不存在，實際回 404", reproSteps: ["呼叫 GET /missing"] },
    });
    await prisma.runStep.create({
      data: { runId: run.id, testCaseId: caseIds[0], seq: 1, phase: "executing", action: { type: "http_request", params: { method: "GET", path: "/missing" } }, intent: "呼叫端點", observation: "回 404", result: { ok: true, durationMs: 5, detail: { status: 404 } } },
    });
    // The ask uses the "discuss" purpose; give it a config + a plain-text stub.
    const cfg = await prisma.llmConfig.findFirstOrThrow({ where: { name: "stub" } });
    await prisma.llmFallbackChain.deleteMany({ where: { purpose: "discuss" } });
    await prisma.llmFallbackChain.create({ data: { purpose: "discuss", order: 0, llmConfigId: cfg.id } });
    const textAdapter: LlmProviderAdapter = {
      async complete(_c, req) {
        const ctx = String(req.messages[0]?.content ?? "");
        return { text: ctx.includes("404") ? "這條失敗是因為 endpoint 不存在(404)，去檢查路由設定。" : "沒有看到證據", model: "stub-ask", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: false };
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: textAdapter, openai: textAdapter, ollama: textAdapter });

    const res = await api(app).post(`/api/runs/${run.id}/ask`).set("Cookie", viewer)
      .send({ question: "為什麼失敗？", resultId: result.id }).expect(201);
    expect(res.body.answer).toContain("endpoint 不存在");
    await api(app).post(`/api/runs/${run.id}/ask`).set("Cookie", viewer).send({ question: " " }).expect(400);
  }, 60_000);

  it("records a finding without letting it become the verdict", async () => {
    stubModel((call) => {
      if (call === 1) {
        return { type: "report_finding", params: { severity: "major", title: "登出按鈕壞了", description: "點了沒反應" } };
      }
      if (call === 2) return { type: "http_request", params: { method: "GET", path: "/ok" } };
      return null;
    });
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);

    const findings = await api(app).get(`/api/runs/${run.id}/findings`).set("Cookie", viewer).expect(200);
    expect(findings.body).toHaveLength(1);
    expect(findings.body[0]).toMatchObject({ severity: "major", title: "登出按鈕壞了", status: "open" });

    const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
    expect(detail.body.cases[0].result.verdict).toBe("pass");

    const updated = await api(app).post(`/api/findings/${findings.body[0].id}/status`).set("Cookie", editor)
      .send({ status: "dismissed" }).expect(201);
    expect(updated.body.status).toBe("dismissed");
  }, 60_000);

  it("turns a finding into a regression case after the reviewer confirms it (§4.7)", async () => {
    stubModel((call) =>
      call === 1
        ? { type: "report_finding", params: { severity: "critical", title: "刪除後列表沒有更新", description: "刪掉的項目還在" } }
        : null,
    );
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);
    const finding = (await api(app).get(`/api/runs/${run.id}/findings`).set("Cookie", viewer).expect(200)).body[0];

    // The model drafts; nothing is written yet.
    const before = await prisma.testCase.count({ where: { targetId } });
    stubCaseWriter({
      feature_ref: "刪除待辦",
      title: "刪除待辦後列表不應再顯示該項目",
      precondition: "已建立一筆待辦",
      steps: ["建立待辦", "刪除它", "重新讀取列表"],
      expected: "列表裡沒有那一筆",
      priority: "P0",
      type: "negative",
    });
    const draft = await api(app).post(`/api/findings/${finding.id}/test-case/draft`)
      .set("Cookie", editor).expect(201);
    expect(draft.body.title).toContain("刪除待辦後");
    expect(draft.body.steps).toHaveLength(3);
    expect(await prisma.testCase.count({ where: { targetId } })).toBe(before);

    // A viewer cannot draft or save.
    await api(app).post(`/api/findings/${finding.id}/test-case/draft`).set("Cookie", viewer).expect(403);

    // The reviewer edits before saving, and the edit is what lands.
    const saved = await api(app).post(`/api/findings/${finding.id}/test-case`).set("Cookie", editor)
      .send({ ...draft.body, expected: "列表裡沒有那一筆，且總數少一" }).expect(201);
    expect(saved.body.source).toBe("finding");
    expect(saved.body.expected).toBe("列表裡沒有那一筆，且總數少一");

    const created = await prisma.testCase.findUniqueOrThrow({
      where: { id: saved.body.id },
      include: { feature: true, versions: true },
    });
    expect(created.feature?.name).toBe("刪除待辦");
    expect(created.versions).toHaveLength(1);

    const after = await prisma.runFinding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(after.status).toBe("converted_to_case");
    expect(after.convertedCaseId).toBe(created.id);

    // Converting the same finding twice would quietly duplicate the case.
    await api(app).post(`/api/findings/${finding.id}/test-case`).set("Cookie", editor)
      .send({ ...draft.body }).expect(400);
  }, 60_000);

  it("refuses a confirmed draft with no steps", async () => {
    stubModel((call) =>
      call === 1 ? { type: "report_finding", params: { severity: "minor", title: "小問題", description: "" } } : null,
    );
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);
    const finding = (await api(app).get(`/api/runs/${run.id}/findings`).set("Cookie", viewer).expect(200)).body[0];
    await api(app).post(`/api/findings/${finding.id}/test-case`).set("Cookie", editor)
      .send({ title: "沒有步驟", steps: [], expected: "x" }).expect(400);
  }, 60_000);

  it("records which models served the run and where the chain fell over (§4.7)", async () => {
    // A second config, so there is something to fall over to.
    const second = await prisma.llmConfig.create({
      data: {
        name: "backup", provider: "openai", model: "stub-backup",
        purposes: ["execute"], supportsVision: true,
      },
    });
    await prisma.llmFallbackChain.create({ data: { purpose: "execute", llmConfigId: second.id, order: 1 } });

    let firstCalls = 0;
    const flaky: LlmProviderAdapter = {
      async complete(cfg, req) {
        // The primary fails the first call of the run, then behaves.
        if (cfg.model !== "stub-backup" && firstCalls++ === 0) {
          throw new LlmProviderError("server", "primary is having a moment", 502);
        }
        if (req.jsonSchema?.name === "case_verdict") {
          return json({
            schema_version: "1.0", verdict: "pass", reasoning: "ok",
            evidence_refs: [], repro_steps: [], possibly_changed: false,
          });
        }
        return json({
          schema_version: "1.0", phase: "judging", observation: "看完了", intent: "收工",
          action: { type: "done", params: { summary: "做完了" } },
        });
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: flaky, openai: flaky, ollama: flaky });

    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);

    const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
    const usage = detail.body.run.llmUsage;
    expect(usage.configs.length).toBeGreaterThanOrEqual(2);
    expect(usage.configs.find((c: { configName: string }) => c.configName === "backup").calls).toBeGreaterThan(0);
    expect(usage.switches.length).toBeGreaterThanOrEqual(1);
    expect(usage.switches[0]).toMatchObject({ toConfigName: "backup" });
    expect(usage.switches[0].reason).toContain("moment");

    await prisma.llmFallbackChain.deleteMany({ where: { llmConfigId: second.id } });
    await prisma.llmConfig.delete({ where: { id: second.id } });
    // The primary took a failure on purpose; clear it so later tests start clean.
    const primary = await prisma.llmConfig.findFirstOrThrow({ where: { name: "stub" } });
    await app.get(LlmHealthService).resetAfterEdit(primary.id);
  }, 60_000);

  it("stops a case at the step cap and blocks it rather than looping", async () => {
    await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxStepsPerCase: 3 } });
    stubModel(
      () => ({ type: "http_request", params: { method: "GET", path: "/ok" } }), // never says done
      { verdict: "blocked", reasoning: "步數用完" },
    );
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed"]);

    const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
    expect(detail.body.cases[0].result).toMatchObject({ verdict: "blocked", stepCount: 3 });
    await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxStepsPerCase: 60 } });
  }, 60_000);

  describe("one run per target (§4.5)", () => {
    it("refuses a second run and leaves the first alone", async () => {
      stubModel((call) => (call <= 2 ? { type: "wait", params: { ms: 400 } } : null));
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(201);

      const second = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(409);
      expect(second.body.message).toMatch(/正在執行 QA/);
      await waitForRun(["succeeded", "failed", "aborted"], 60_000);
    }, 90_000);

    it("locks the target while running and unlocks it afterwards", async () => {
      const target = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
      expect(target.body.status).toBe("idle");
    });
  });

  describe("steering a run in flight (§4.6)", () => {
    it("skips a queued case and aborts the rest", async () => {
      stubModel((call) => (call % 3 === 0 ? null : { type: "wait", params: { ms: 300 } }));
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(201);

      await api(app).post(`/api/targets/${targetId}/runs/skip-case`).set("Cookie", editor)
        .send({ caseId: caseIds[2] }).expect(201);
      const aborted = await api(app).post(`/api/targets/${targetId}/runs/abort`).set("Cookie", editor).expect(201);
      expect(aborted.body).toEqual({ aborted: true });

      const run = await waitForRun(["aborted", "succeeded", "failed"], 60_000);
      expect(run.status).toBe("aborted");
      const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
      expect(detail.body.cases.some((c: { queueStatus: string }) => c.queueStatus === "skipped")).toBe(true);
    }, 90_000);

    it("rejects skipping a case that is not queued, and aborting when nothing runs", async () => {
      await api(app).post(`/api/targets/${targetId}/runs/abort`).set("Cookie", editor).expect(201)
        .then((r) => expect(r.body).toEqual({ aborted: false }));
      await api(app).post(`/api/targets/${targetId}/runs/skip-case`).set("Cookie", editor)
        .send({ caseId: caseIds[0] }).expect(400);
    });
  });

  describe("editing cases while a run is going (§4.5)", () => {
    it("allows a queued case to be edited but not the one executing", async () => {
      stubModel((call) => (call <= 6 ? { type: "wait", params: { ms: 300 } } : null));
      // Serial run: this test asserts the "one executing / rest queued" §4.6 semantics.
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ concurrency: 1 }).expect(201);

      // Wait until the first case is actually executing.
      const deadline = Date.now() + 10_000;
      let runningCaseId: string | null = null;
      while (Date.now() < deadline && !runningCaseId) {
        const rows = await prisma.runCaseQueue.findMany({ where: { status: "running" } });
        runningCaseId = rows[0]?.testCaseId ?? null;
        if (!runningCaseId) await new Promise((r) => setTimeout(r, 100));
      }
      expect(runningCaseId).toBeTruthy();

      const locked = await api(app).patch(`/api/test-cases/${runningCaseId}`).set("Cookie", editor)
        .send({ title: "不該改得動" }).expect(409);
      expect(locked.body.message).toMatch(/正在執行中/);

      const queued = caseIds.find((id) => id !== runningCaseId)!;
      await api(app).patch(`/api/test-cases/${queued}`).set("Cookie", editor)
        .send({ title: "排隊中可以改" }).expect(200);

      // A case can also be added to the run that is already going.
      const extra = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title: "臨時加的", steps: ["a"], expected: "b" }).expect(201);
      const added = await api(app).post(`/api/targets/${targetId}/runs/add-case`).set("Cookie", editor)
        .send({ caseId: extra.body.id }).expect(201);
      expect(added.body.added).toBe(true);

      await api(app).post(`/api/targets/${targetId}/runs/abort`).set("Cookie", editor).expect(201);
      await waitForRun(["aborted", "succeeded", "failed"], 60_000);
    }, 90_000);

    it("reports per-case lock state in the list rather than locking everything", async () => {
      const list = await api(app).get(`/api/targets/${targetId}/test-cases`).set("Cookie", viewer).expect(200);
      expect(list.body.target.locked).toBe(false);
      expect(list.body.target.running).toBe(false);
    });
  });

  it("parks the run when no model can serve and finishes it once one returns", async () => {
    const dead: LlmProviderAdapter = {
      async complete() {
        throw new LlmProviderError("server", "upstream down", 503);
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: dead, openai: dead, ollama: dead });
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
      .send({ caseIds: [caseIds[0]] }).expect(201);

    const parked = await waitForRun(["paused"], 30_000);
    expect(parked.pausedReason).toBeTruthy();
    expect(parked.endedAt).toBeNull();

    stubModel(() => null);
    await app.get(LlmHealthService).resetAfterEdit((await prisma.llmConfig.findFirstOrThrow()).id);

    const finished = await waitForRun(["succeeded", "failed"], 30_000);
    expect(finished.status).toBe("succeeded");
    expect(finished.pausedReason).toBeNull();
  }, 90_000);

  describe("human review (§4.7)", () => {
    it("records a human verdict beside the model's without overwriting it", async () => {
      stubModel(() => null, { verdict: "pass" });
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
        .send({ caseIds: [caseIds[0]] }).expect(201);
      const run = await waitForRun(["succeeded", "failed"]);

      const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
      const resultId = detail.body.cases[0].result.id;

      await api(app).post(`/api/results/${resultId}/review`).set("Cookie", viewer).send({ verdict: "fail" }).expect(403);
      const reviewed = await api(app).post(`/api/results/${resultId}/review`).set("Cookie", editor)
        .send({ verdict: "fail", note: "其實沒驗到" }).expect(201);

      expect(reviewed.body).toMatchObject({ verdict: "pass", humanVerdict: "fail", humanNote: "其實沒驗到" });
      expect(reviewed.body.reviewedById).toBeTruthy();
    }, 60_000);
  });

  it("guards evidence reads to the run that owns them", async () => {
    const run = await prisma.testRun.findFirstOrThrow({ where: { targetId }, orderBy: { startedAt: "desc" } });
    await api(app).get(`/api/runs/${run.id}/evidence`).query({ key: "runs/other-run/x.png" })
      .set("Cookie", viewer).expect(403);
    await api(app).get(`/api/runs/${run.id}/evidence`).query({ key: `runs/${run.id}/../escape.png` })
      .set("Cookie", viewer).expect(403);
  });

  it("closes out a run orphaned by a restart and releases the target", async () => {
    const orphan = await prisma.testRun.create({
      data: { targetId, status: "running", triggeredById: "someone" },
    });
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });

    await app.get(RunService).onModuleInit();

    const closed = await prisma.testRun.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(closed.status).toBe("interrupted"); // environment cut it short, not a test failure
    expect(closed.error).toMatch(/重新啟動/);
    const target = await prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.status).toBe("idle");
  });

  it("clears screenshots once a run is past the retention window, keeping the transcript", async () => {
    // Pick a run that actually produced a transcript, not the orphan closed above.
    const run = await prisma.testRun.findFirstOrThrow({
      where: { targetId, endedAt: { not: null }, steps: { some: {} }, results: { some: {} } },
      orderBy: { startedAt: "desc" },
    });
    // Pretend the run is older than the retention window.
    await prisma.sandboxSettings.update({ where: { id: 1 }, data: { retentionDays: 1 } });
    await prisma.testRun.update({
      where: { id: run.id },
      data: { endedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });
    await prisma.runStep.updateMany({ where: { runId: run.id }, data: { screenshotKey: "runs/x/y.png" } });
    await prisma.testResult.updateMany({
      where: { runId: run.id },
      data: { evidence: { screenshots: ["runs/x/1.png"], video: "runs/x/rec.mp4", httpLogs: [{ method: "GET" }] } },
    });

    const swept = await app.get(RetentionService).sweep();
    expect(swept.runs).toBeGreaterThanOrEqual(1);

    const after = await prisma.testRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.evidencePurgedAt).not.toBeNull();
    const steps = await prisma.runStep.findMany({ where: { runId: run.id } });
    expect(steps.length).toBeGreaterThan(0); // the transcript survives
    expect(steps.every((s) => s.screenshotKey === null)).toBe(true);
    const results = await prisma.testResult.findMany({ where: { runId: run.id } });
    expect(results.length).toBeGreaterThan(0); // so do the verdicts
    // The keys go with the objects: a dead link is worse than an empty list.
    for (const r of results) {
      const evidence = r.evidence as { screenshots: string[]; video: string | null; httpLogs: unknown[] };
      expect(evidence.screenshots).toEqual([]);
      expect(evidence.video).toBeNull();
      expect(evidence.httpLogs).toHaveLength(1); // small, and most verdicts rest on it
    }

    // A second sweep does not redo work already done.
    expect((await app.get(RetentionService).sweep()).runs).toBe(0);
    await prisma.sandboxSettings.update({ where: { id: 1 }, data: { retentionDays: 30 } });
  }, 60_000);

  it("writes an audit trail", async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["run.start", "run.abort", "result.review"]));
  });

  describe("API 前置流程 / setup flow (§4.4)", () => {
    afterEach(async () => {
      // Leave no persisted setup behind — later tests assume none runs.
      await prisma.apiSetup.deleteMany({ where: { targetId } });
    });

    it("rejects an invalid capture name and stores a valid flow", async () => {
      await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "login", request: { method: "POST", path: "/login" }, captures: [{ name: "1bad", from: "body.x" }] }] })
        .expect(400);
      // viewers cannot edit
      await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", viewer)
        .send({ steps: [] }).expect(403);

      const put = await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "登入取得 token", request: { method: "POST", path: "/login", body: { u: "a" } }, captures: [{ name: "sessionPath", from: "body.path" }] }] })
        .expect(200);
      expect(put.body.steps).toHaveLength(1);
      const got = await api(app).get(`/api/targets/${targetId}/api-setup`).set("Cookie", viewer).expect(200);
      expect(got.body.steps[0].captures[0]).toMatchObject({ name: "sessionPath", from: "body.path" });
    });

    it("runs the flow once before the cases and exposes captured vars as {{name}}", async () => {
      await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "登入", request: { method: "POST", path: "/login" }, captures: [{ name: "sessionPath", from: "body.path" }] }] })
        .expect(200);
      // The case uses the captured variable in a header; the test server echoes auth.
      stubModel((call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/me", headers: { Authorization: "Bearer {{sessionPath}}" } } } : null));
      const started = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
        .send({ caseIds: [caseIds[0]] }).expect(201);
      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("succeeded");

      // Setup ran exactly once, recorded as a run-level step (no case).
      const setupSteps = await prisma.runStep.findMany({ where: { runId: run.id, phase: "setup" } });
      expect(setupSteps).toHaveLength(1);
      expect(setupSteps[0].testCaseId).toBeNull();
      // The captured value (body.path === "/login") reached the case request.
      const meReq = requests.find((r) => r.url === "/me");
      expect(meReq?.auth).toBe("Bearer /login");
      // GET steps surfaces the setup step for replay.
      const steps = await api(app).get(`/api/runs/${run.id}/steps`).set("Cookie", viewer).expect(200);
      expect(steps.body.some((s: { phase: string }) => s.phase === "setup")).toBe(true);
    }, 60_000);

    it("masks a long captured secret in the stored setup transcript", async () => {
      // The test server echoes back whatever path was hit; use a long unique path
      // so the captured value crosses the secret-length threshold and is masked.
      const secretPath = "/session-" + "z".repeat(24);
      await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "登入", request: { method: "POST", path: secretPath }, captures: [{ name: "sess", from: "body.path" }] }] })
        .expect(200);
      stubModel((call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/ok" } } : null));
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ caseIds: [caseIds[0]] }).expect(201);
      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("succeeded");
      const setup = await prisma.runStep.findFirstOrThrow({ where: { runId: run.id, phase: "setup" } });
      // The captured value must not appear verbatim in the stored response.
      expect(JSON.stringify(setup.result)).not.toContain(secretPath);
      expect(JSON.stringify(setup.result)).toContain("****");
    }, 60_000);

    it("fails the run when the setup flow cannot complete", async () => {
      await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "登入", request: { method: "POST", path: "/login" }, captures: [{ name: "token2", from: "body.not_there" }] }] })
        .expect(200);
      stubModel((call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/ok" } } : null));
      const started = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor)
        .send({ caseIds: [caseIds[0]] }).expect(201);
      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("前置流程");
      // No case executed: the queued case was skipped.
      const results = await prisma.testResult.findMany({ where: { runId: run.id } });
      expect(results).toHaveLength(0);
    }, 60_000);
  });

  describe("feature 層級前置流程 / feature-scoped setup (§4.4)", () => {
    let t2: string, f1: string, f2: string, c1: string, c2: string;
    beforeAll(async () => {
      const tg = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
        .send({ name: "API-F", kind: "api", config: { base_url: apiBase }, description: "feature setup 測試" }).expect(201);
      t2 = tg.body.id;
      const ff1 = await api(app).post(`/api/targets/${t2}/features`).set("Cookie", editor).send({ name: "建立資源", description: "" }).expect(201);
      const ff2 = await api(app).post(`/api/targets/${t2}/features`).set("Cookie", editor).send({ name: "壞前置", description: "" }).expect(201);
      f1 = ff1.body.id; f2 = ff2.body.id;
      const cc1 = await api(app).post(`/api/targets/${t2}/test-cases`).set("Cookie", editor)
        .send({ title: "用 feature 變數", steps: ["x"], expected: "ok", priority: "P1", featureId: f1 }).expect(201);
      const cc2 = await api(app).post(`/api/targets/${t2}/test-cases`).set("Cookie", editor)
        .send({ title: "前置會壞", steps: ["x"], expected: "ok", priority: "P1", featureId: f2 }).expect(201);
      c1 = cc1.body.id; c2 = cc2.body.id;
    });

    it("only editors can edit a feature flow, and it round-trips", async () => {
      await api(app).put(`/api/features/${f1}/api-setup`).set("Cookie", viewer).send({ steps: [] }).expect(403);
      const put = await api(app).put(`/api/features/${f1}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "建立", request: { method: "POST", path: "/create-resource" }, captures: [{ name: "resPath", from: "body.path" }] }] })
        .expect(200);
      expect(put.body.steps[0].captures[0].name).toBe("resPath");
      const got = await api(app).get(`/api/features/${f1}/api-setup`).set("Cookie", viewer).expect(200);
      expect(got.body.steps).toHaveLength(1);
    });

    it("runs a feature flow before that feature's cases; a broken feature flow blocks only its own cases", async () => {
      // F1: works, captures resPath and the case uses it. F2: capture path missing -> fails.
      await api(app).put(`/api/features/${f1}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "建立資源", request: { method: "POST", path: "/create-resource" }, captures: [{ name: "resPath", from: "body.path" }] }] }).expect(200);
      await api(app).put(`/api/features/${f2}/api-setup`).set("Cookie", editor)
        .send({ steps: [{ label: "壞掉", request: { method: "POST", path: "/whatever" }, captures: [{ name: "gone", from: "body.not_there" }] }] }).expect(200);

      // Route the F1 case to send its captured var in a header; the server echoes auth.
      requests = [];
      let call = 0;
      const adapter: LlmProviderAdapter = {
        async complete(_c, req: LlmRequest) {
          if (req.jsonSchema?.name === "execution_step" && req.messages.length === 1) call = 0;
          if (req.jsonSchema?.name === "case_verdict") return json({ schema_version: "1.0", verdict: "pass", reasoning: "ok", evidence_refs: ["step-1"], repro_steps: [], possibly_changed: false });
          call++;
          const action = call <= 1 ? { type: "http_request", params: { method: "GET", path: "/echo", headers: { Authorization: "Bearer {{resPath}}" } } } : null;
          return json({ schema_version: "1.0", phase: action ? "executing" : "judging", observation: "s", intent: "i", action: action ?? { type: "done", params: { summary: "done" } } });
        },
      };
      app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });

      const started = await api(app).post(`/api/targets/${t2}/runs`).set("Cookie", editor).send({}).expect(201);
      const runId = started.body.runId;
      const deadline = Date.now() + 20_000;
      let run;
      while (Date.now() < deadline) {
        run = await prisma.testRun.findUnique({ where: { id: runId } });
        if (run && ["succeeded", "failed", "aborted"].includes(run.status)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(run?.status).toBe("succeeded"); // a broken feature flow does not fail the whole run

      const results = await prisma.testResult.findMany({ where: { runId } });
      const byCase = new Map(results.map((r) => [r.testCaseId, r]));
      expect(byCase.get(c1)?.verdict).toBe("pass");
      expect(byCase.get(c2)?.verdict).toBe("blocked");
      expect(byCase.get(c2)?.llmReasoning).toContain("前置流程失敗");
      // F1's captured var reached its case; F2 never executed a request.
      const echo = requests.find((r) => r.url === "/echo");
      expect(echo?.auth).toBe("Bearer /create-resource");
      // Both feature flows recorded as run-level setup steps.
      const setup = await prisma.runStep.findMany({ where: { runId, phase: "setup" } });
      expect(setup.length).toBe(2);
    }, 60_000);
  });

  it("drops verdict evidence refs that point at no real step (§4.7)", async () => {
    stubModel(
      (call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/ok" } } : null),
      { evidence_refs: ["step-1", "step-99"] },
    );
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ caseIds: [caseIds[0]] }).expect(201);
    const run = await waitForRun(["succeeded", "failed", "aborted"]);
    const result = await prisma.testResult.findFirstOrThrow({ where: { runId: run.id, testCaseId: caseIds[0] } });
    const ev = result.evidence as { evidenceRefs: string[] };
    expect(ev.evidenceRefs).toContain("step-1");
    expect(ev.evidenceRefs).not.toContain("step-99");
  }, 60_000);

  it("locks the target during exploration: no QA run, no generate, no case edits (§4.6 防呆)", async () => {
    // Simulate an exploration holding the lock (no sandbox needed for the guard).
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
    const exp = await prisma.explorationRun.create({ data: { targetId, status: "running", triggeredById: (await prisma.user.findFirstOrThrow({ where: { email: "editor@r.local" } })).id } });
    try {
      const run = await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(409);
      expect(run.body.message).toContain("探索");
      const gen = await api(app).post(`/api/targets/${targetId}/generate`).set("Cookie", editor).send({}).expect(409);
      expect(gen.body.message).toContain("探索");
      const edit = await api(app).patch(`/api/test-cases/${caseIds[0]}`).set("Cookie", editor).send({ title: "改標題" }).expect(409);
      expect(edit.body.message).toContain("唯讀");
    } finally {
      await prisma.explorationRun.update({ where: { id: exp.id }, data: { status: "failed", endedAt: new Date() } });
      await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
    }
    // Lock released -> edits work again.
    await api(app).patch(`/api/test-cases/${caseIds[0]}`).set("Cookie", editor).send({ title: "改標題" }).expect(200);
  }, 60_000);

  describe("bounded parallel execution (§4.6)", () => {
    // Adapter that measures how many LLM calls overlap, and drives each case to do
    // one http_request then finish (per-conversation, so it is parallel-safe).
    function trackingStub() {
      let inflight = 0, maxInflight = 0;
      const adapter: LlmProviderAdapter = {
        async complete(_c, req: LlmRequest) {
          inflight++; maxInflight = Math.max(maxInflight, inflight);
          await new Promise((r) => setTimeout(r, 60));
          inflight--;
          if (req.jsonSchema?.name === "case_verdict") {
            return json({ schema_version: "1.0", verdict: "pass", reasoning: "ok", evidence_refs: ["step-1"], repro_steps: [], possibly_changed: false });
          }
          const first = req.messages.length <= 1;
          return json({ schema_version: "1.0", phase: first ? "executing" : "judging", observation: "s", intent: "i", action: first ? { type: "http_request", params: { method: "GET", path: "/ok" } } : { type: "done", params: { summary: "done" } } });
        },
      };
      app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
      return () => maxInflight;
    }

    it("runs api cases concurrently when concurrency > 1", async () => {
      const maxInflight = trackingStub();
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ concurrency: 4 }).expect(201);
      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("succeeded");
      // 3 active cases with concurrency 4 → their LLM calls must have overlapped.
      expect(maxInflight()).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it("stays sequential when concurrency = 1 (no overlap)", async () => {
      const maxInflight = trackingStub();
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ concurrency: 1 }).expect(201);
      const run = await waitForRun(["succeeded", "failed", "aborted"]);
      expect(run.status).toBe("succeeded");
      expect(maxInflight()).toBe(1);
    }, 60_000);
  });

  // A dead system: the agent aborts the whole run instead of burning tokens on
  // every case against something it cannot even connect to.
  it("aborts the entire run when the agent reports a system-wide fatal error", async () => {
    stubModel((call) => (call === 1 ? { type: "abort_run", params: { reason: "首頁連線被拒，整站打不開" } } : null));
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ caseIds, concurrency: 1 }).expect(201);
    const run = await waitForRun(["succeeded", "failed", "aborted", "interrupted"]);

    // The run is interrupted (system down), not a normal completion / test failure.
    expect(run.status).toBe("interrupted");
    expect(run.error).toMatch(/系統無法連線|連線被拒/);

    const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
    const done = detail.body.cases.filter((c: { queueStatus: string }) => c.queueStatus === "done");
    const skipped = detail.body.cases.filter((c: { queueStatus: string }) => c.queueStatus === "skipped");
    // Only the first case ran (blocked); the rest were skipped, not executed.
    expect(done).toHaveLength(1);
    expect(done[0].result.verdict).toBe("blocked");
    expect(skipped.length).toBeGreaterThanOrEqual(caseIds.length - 1);

    // A critical finding records why everything stopped.
    const finding = await prisma.runFinding.findFirst({ where: { runId: run.id, severity: "critical" } });
    expect(finding?.title).toMatch(/系統無法連線/);

    // The interrupted run can be continued: a fresh run over just the not-done cases.
    stubModel((call) => (call <= 1 ? { type: "http_request", params: { method: "GET", path: "/ok" } } : null));
    const cont = await api(app).post(`/api/runs/${run.id}/continue`).set("Cookie", editor).expect(201);
    expect(cont.body.total).toBe(caseIds.length - 1); // the aborted case was done(blocked); the rest continue
    const next = await waitForRun(["succeeded", "failed"]);
    expect(next.id).not.toBe(run.id);
    expect(next.status).toBe("succeeded");
  }, 60_000);

  // A run can change the target's own state; a credential is part of that state.
  // When a case changes one, the stored value must follow so the next login works.
  describe("credential rotation keeps the stored value in sync", () => {
    let rotCaseId: string;

    beforeAll(async () => {
      // A rotatable credential and a non-rotatable one to prove the guard.
      await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner)
        .send({ key: "user_pw", value: "old-password-123", allowRotation: true }).expect(200);
      const c = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", editor)
        .send({ title: "改 user 密碼", steps: ["以 admin 改掉 user 的密碼"], expected: "密碼變更成功", priority: "P1" }).expect(201);
      rotCaseId = c.body.id;
    });

    it("syncs the stored credential to the new value after a 2xx change", async () => {
      stubModel((call) => {
        if (call === 1) return { type: "rotate_credential", params: { credential: "user_pw" } };
        if (call === 2) return { type: "http_request", params: { method: "PUT", path: "/users/1/password", body: { password: "{{user_pw__next}}" } } };
        return null;
      });
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ caseIds: [rotCaseId] }).expect(201);
      const run = await waitForRun(["succeeded", "failed"]);
      expect(run.status).toBe("succeeded");

      // The stored value changed, and it is exactly what the target received —
      // the harness-generated value, never one the model invented.
      const stored = (await app.get(TargetsService).decryptedCredentials(targetId))["user_pw"];
      expect(stored).not.toBe("old-password-123");
      const put = requests.find((r) => r.method === "PUT" && r.url === "/users/1/password");
      expect(put).toBeDefined();
      expect(JSON.parse(put!.body)).toEqual({ password: stored });

      const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
      const evidence = detail.body.cases[0].result.evidence;
      expect(evidence.rotations?.[0]).toMatchObject({ credential: "user_pw", committed: true });
      // The new secret is masked everywhere in the run detail — it never leaks.
      expect(JSON.stringify(detail.body)).not.toContain(stored);
    }, 60_000);

    it("refuses to rotate a credential that is not marked rotatable, leaving it untouched", async () => {
      stubModel((call) => (call === 1 ? { type: "rotate_credential", params: { credential: "token" } } : null));
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({ caseIds: [rotCaseId] }).expect(201);
      const run = await waitForRun(["succeeded", "failed"]);
      expect(run.status).toBe("succeeded");

      expect((await app.get(TargetsService).decryptedCredentials(targetId))["token"]).toBe("super-secret-token");
      const detail = await api(app).get(`/api/runs/${run.id}`).set("Cookie", viewer).expect(200);
      expect(detail.body.cases[0].result.evidence.rotations).toBeUndefined();
    }, 60_000);
  });
});
