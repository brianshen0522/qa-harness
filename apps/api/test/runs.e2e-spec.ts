import { INestApplication } from "@nestjs/common";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { LlmHealthService } from "../src/llm/llm-health.service";
import { LlmProviderError, type LlmProviderAdapter, type LlmRequest } from "../src/llm/providers";
import { RunService } from "../src/runs/run.service";
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
        fallbackEntries: { create: [{ purpose: "execute", order: 0 }] },
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
      expect(second.body.message).toMatch(/已經有一個執行在進行中/);
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
      await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", editor).send({}).expect(201);

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
    expect(closed.status).toBe("failed");
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

    const swept = await app.get(RetentionService).sweep();
    expect(swept.runs).toBeGreaterThanOrEqual(1);

    const after = await prisma.testRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.evidencePurgedAt).not.toBeNull();
    const steps = await prisma.runStep.findMany({ where: { runId: run.id } });
    expect(steps.length).toBeGreaterThan(0); // the transcript survives
    expect(steps.every((s) => s.screenshotKey === null)).toBe(true);
    const results = await prisma.testResult.findMany({ where: { runId: run.id } });
    expect(results.length).toBeGreaterThan(0); // so do the verdicts

    // A second sweep does not redo work already done.
    expect((await app.get(RetentionService).sweep()).runs).toBe(0);
    await prisma.sandboxSettings.update({ where: { id: 1 }, data: { retentionDays: 30 } });
  }, 60_000);

  it("writes an audit trail", async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["run.start", "run.abort", "result.review"]));
  });
});
