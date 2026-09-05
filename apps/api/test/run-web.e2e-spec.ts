import { INestApplication } from "@nestjs/common";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { LlmGatewayService } from "../src/llm/llm-gateway.service";
import { SandboxService } from "../src/sandbox/sandbox.service";
import { ComputerService } from "../src/sandbox/computer.service";
import { EvidenceService } from "../src/runs/evidence.service";
import type { LlmProviderAdapter, LlmRequest } from "../src/llm/providers";

/**
 * The sandbox/vision branch of run.service is never hit by the api-only run e2e.
 * This stubs the sandbox, the in-container computer and evidence storage so a WEB
 * run executes end-to-end: it proves the done-frame is stored and the judge is
 * actually shown the screenshots (vision), not just the agent's self-report.
 */
describe("web run: sandbox + vision judge (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, targetId: string, caseId: string;
  let judgeSawImage = false;

  const json = (body: unknown) => ({ text: JSON.stringify(body), model: "stub", usage: { inputTokens: 1, outputTokens: 1 }, nativeJson: true });

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    await prisma.sandboxSettings.upsert({ where: { id: 1 }, create: { recordVideo: false }, update: { recordVideo: false } });
    await prisma.llmConfig.create({
      data: { name: "stub", provider: "anthropic", model: "stub", purposes: ["execute"], supportsVision: true, fallbackEntries: { create: [{ purpose: "execute", order: 0 }] } },
    });
    owner = await loginUser(app, "owner@web.local");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId: team.body.id, name: "P", description: "d" }).expect(201);
    const target = await api(app).post(`/api/projects/${project.body.id}/targets`).set("Cookie", owner)
      .send({ name: "Web", kind: "web", config: { url: "http://127.0.0.1:9/app" }, description: "d" }).expect(201);
    targetId = target.body.id;
    const c = await api(app).post(`/api/targets/${targetId}/test-cases`).set("Cookie", owner)
      .send({ title: "登入頁載入", steps: ["開啟登入頁"], expected: "看到登入表單", priority: "P1" }).expect(201);
    caseId = c.body.id;

    // Stub the sandbox + computer + evidence so no Docker/S3 is needed.
    const sandbox = app.get(SandboxService);
    (sandbox as unknown as { create: unknown }).create = async () => ({ id: "sbx", agentPort: 1, name: "sbx", viewUrl: "http://x", resolution: "1280x800", novncPort: 0, createdAt: "", expiresAt: null, createdBy: null });
    (sandbox as unknown as { remove: unknown }).remove = async () => undefined;
    const computer = app.get(ComputerService);
    (computer as unknown as { screenshot: unknown }).screenshot = async () => ({ ok: true, action: "screenshot", durationMs: 1, image: "aGVsbG8=", detail: {} });
    (computer as unknown as { startRecording: unknown }).startRecording = async () => ({ ok: true, action: "record_start", durationMs: 1, detail: {} });
    (computer as unknown as { stopRecording: unknown }).stopRecording = async () => ({ ok: true, action: "record_stop", durationMs: 1, detail: {} });
    const evidence = app.get(EvidenceService);
    (evidence as unknown as { putScreenshot: unknown }).putScreenshot = async (runId: string, cId: string | null, seq: number) => ({ key: `runs/${runId}/${cId}/${seq}.png`, bytes: 5 });

    // Execute agent: finish immediately; judge: pass, and note whether it got images.
    const adapter: LlmProviderAdapter = {
      async complete(_c, req: LlmRequest) {
        if (req.jsonSchema?.name === "case_verdict") {
          const c0 = req.messages[0]?.content;
          judgeSawImage = Array.isArray(c0) && c0.some((p) => p.type === "image");
          return json({ schema_version: "1.0", verdict: "pass", reasoning: "看到表單", evidence_refs: ["step-1"], repro_steps: [], possibly_changed: false });
        }
        return json({ schema_version: "1.0", phase: "judging", observation: "登入表單已出現", intent: "收工", action: { type: "done", params: { summary: "done" } } });
      },
    };
    app.get(LlmGatewayService).setProviders({ anthropic: adapter, openai: adapter, ollama: adapter });
  });

  afterAll(async () => {
    await app.close();
    await closeFetchPool();
  });

  it("runs a web target through the sandbox, stores the done-frame, and shows the judge the screenshots", async () => {
    await api(app).post(`/api/targets/${targetId}/runs`).set("Cookie", owner).send({ caseIds: [caseId] }).expect(201);
    const deadline = Date.now() + 20_000;
    let run;
    while (Date.now() < deadline) {
      run = await prisma.testRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
      if (run && ["succeeded", "failed", "aborted"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run?.status).toBe("succeeded");

    const result = await prisma.testResult.findFirstOrThrow({ where: { runId: run!.id, testCaseId: caseId } });
    expect(result.verdict).toBe("pass");
    // The final (done) frame was captured as evidence.
    const ev = result.evidence as { screenshots: string[] };
    expect(ev.screenshots.length).toBeGreaterThanOrEqual(1);
    // The judge was actually shown the screenshot, not just the transcript text.
    expect(judgeSawImage).toBe(true);
    // A screenshot step row was persisted for the sandbox path.
    const shots = await prisma.runStep.findMany({ where: { runId: run!.id, screenshotKey: { not: null } } });
    expect(shots.length).toBeGreaterThanOrEqual(1);
  }, 40_000);
});
