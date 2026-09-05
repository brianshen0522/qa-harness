import { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";
import { execSync } from "node:child_process";
import { api, closeFetchPool, createApp, loginAdmin, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { DockerService } from "../src/sandbox/docker.service";
import { SandboxService } from "../src/sandbox/sandbox.service";

/**
 * Spec §4.8: the admin must be able to start a sandbox and confirm the
 * environment works. The container tests drive real Docker, so they are skipped
 * (visibly — Jest marks them skipped, not passed) when Docker or the sandbox
 * image is unavailable. The probe runs synchronously at load so the skip is
 * decided at collection time rather than silently returning inside each test.
 */
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "qa-harness-sandbox:0.5";
function dockerReadySync(): boolean {
  try {
    execSync("docker version", { stdio: "ignore", timeout: 10_000 });
    execSync(`docker image inspect ${SANDBOX_IMAGE}`, { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
const DOCKER_READY = dockerReadySync();
const describeDocker = DOCKER_READY ? describe : describe.skip;
if (!DOCKER_READY) {
  // eslint-disable-next-line no-console
  console.warn(`[sandbox.e2e] Docker or image ${SANDBOX_IMAGE} unavailable — container tests will be SKIPPED (not passed).`);
}

describe("admin sandbox (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let user: string;
  let port = 0;
  const started: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    admin = await loginAdmin(app, prisma);
    user = await loginUser(app, "member@s.local");
    // A real port, so the SSE test can read the stream with fetch instead of
    // aborting a supertest request (which leaks into the next test).
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    // The daemon is shared with whatever else is running on this machine, so the
    // suite raises its own ceiling instead of competing for the configured one.
    // resetDb drops the settings singleton; recreate it (and raise the ceiling when Docker is here).
    await prisma.sandboxSettings.upsert({ where: { id: 1 }, create: { maxConcurrent: DOCKER_READY ? 99 : undefined }, update: { maxConcurrent: DOCKER_READY ? 99 : 3 } });
  }, 60_000);

  afterAll(async () => {
    const sandbox = app.get(SandboxService);
    await Promise.all(started.map((id) => sandbox.remove(id).catch(() => undefined)));
    await app.close();
    await closeFetchPool();
  }, 60_000);

  it("is admin-only", async () => {
    await api(app).get("/api/admin/sandbox/status").expect(401);
    // Authenticated but not an admin -> forbidden (was a separate 401 account system before unification).
    await api(app).get("/api/admin/sandbox/status").set("Cookie", user).expect(403);
    await api(app).post("/api/admin/sandbox/instances").set("Cookie", user).send({}).expect(403);
  });

  it("reports docker, image and capacity", async () => {
    const r = await api(app).get("/api/admin/sandbox/status").set("Cookie", admin).expect(200);
    expect(r.body.docker).toHaveProperty("ok");
    expect(r.body.image).toHaveProperty("name");
    expect(r.body.settings.resolution).toMatch(/^\d+x\d+$/);
    expect(typeof r.body.maxConcurrent).toBe("number");
    expect(Array.isArray(r.body.instances)).toBe(true);
  });

  it("404s for an unknown sandbox id", async () => {
    await api(app).get("/api/admin/sandbox/instances/deadbeefdeadbeef").set("Cookie", admin).expect(404);
    await api(app).delete("/api/admin/sandbox/instances/deadbeefdeadbeef").set("Cookie", admin).expect(404);
  });

  describeDocker("with a real container", () => {
    let id: string;

    it("starts a sandbox that is running, healthy and reachable", async () => {
      const r = await api(app).post("/api/admin/sandbox/instances").set("Cookie", admin)
        .send({ startUrl: "about:blank", ttlMinutes: 10 }).expect(201);
      id = r.body.id;
      started.push(id);

      expect(r.body).toMatchObject({ running: true, purpose: "admin-test", resolution: expect.stringMatching(/^\d+x\d+$/) });
      expect(r.body.name).toMatch(/^qa-sandbox-/);
      expect(r.body.novncPort).toBeGreaterThan(0);
      expect(r.body.agentPort).toBeGreaterThan(0);
      expect(r.body.viewUrl).toContain("/vnc.html");
      expect(Date.parse(r.body.expiresAt)).toBeGreaterThan(Date.now());
    }, 120_000);

    it("appears in the list and in the status counts", async () => {
      const list = await api(app).get("/api/admin/sandbox/instances").set("Cookie", admin).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).toContain(id);
      const status = await api(app).get("/api/admin/sandbox/status").set("Cookie", admin).expect(200);
      expect(status.body.running).toBeGreaterThanOrEqual(1);
    });

    it("captures the screen at the configured resolution", async () => {
      const r = await api(app).get(`/api/admin/sandbox/instances/${id}/screenshot`).set("Cookie", admin).expect(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.image).toMatch(/^data:image\/png;base64,/);
      expect(r.body.width).toBe(1280);
      expect(r.body.height).toBe(800);
    }, 30_000);

    it("performs actions and reports failures without throwing", async () => {
      const ok = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "run_command", params: { command: "echo sandbox-ok" } }).expect(201);
      expect(ok.body).toMatchObject({ ok: true, action: "run_command" });
      expect(ok.body.detail.stdout).toContain("sandbox-ok");

      const moved = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "move", params: { x: 640, y: 400 } }).expect(201);
      expect(moved.body).toMatchObject({ ok: true, detail: { x: 640, y: 400 } });

      const missingArg = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "key", params: {} }).expect(201);
      expect(missingArg.body.ok).toBe(false);
      expect(missingArg.body.error).toContain("key is required");

      const unsupported = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "teleport", params: {} }).expect(201);
      expect(unsupported.body.ok).toBe(false);
      expect(unsupported.body.error).toContain("teleport");
    }, 60_000);

    it("clamps coordinates to the screen instead of erroring", async () => {
      const r = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "move", params: { x: 99999, y: -50 } }).expect(201);
      expect(r.body).toMatchObject({ ok: true, detail: { x: 1279, y: 0 } });
    }, 30_000);

    it("exposes container logs", async () => {
      const r = await api(app).get(`/api/admin/sandbox/instances/${id}/logs?tail=50`).set("Cookie", admin).expect(200);
      expect(r.body.logs).toContain("[sandbox]");
      expect(r.body.logs).toContain("computer-use agent");
    }, 30_000);

    it("refuses to exceed the concurrency limit", async () => {
      // Set the ceiling to whatever is already running, so the next start must fail.
      const running = (await app.get(SandboxService).list()).filter((i) => i.running).length;
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: running } });
      const r = await api(app).post("/api/admin/sandbox/instances").set("Cookie", admin).send({}).expect(400);
      expect(r.body.message).toMatch(new RegExp(`並行上限（${running}/${running}）`));
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: 99 } });
    }, 60_000);

    it("reclaims an expired sandbox on sweep", async () => {
      const sandbox = app.get(SandboxService);
      const docker = app.get(DockerService);
      const expired = await sandbox.create("admin-test-user", { ttlMinutes: 5 });
      started.push(expired.id);
      await docker.stopContainer(expired.id);
      const removed = await sandbox.sweep();
      expect(removed).toBeGreaterThanOrEqual(1);
      await api(app).get(`/api/admin/sandbox/instances/${expired.id}`).set("Cookie", admin).expect(404);
    }, 180_000);

    it("holds a steerable conversation: message, interject, stop, reset", async () => {
      const base = `/api/admin/sandbox/instances/${id}/agent`;

      const empty = await api(app).get(`${base}/session`).set("Cookie", admin).expect(200);
      expect(empty.body).toMatchObject({ status: "idle", events: [], turns: 0 });

      // No LLM is configured in this suite, so the round parks rather than failing.
      // That is the behaviour we want, and it still proves the queue, the stream
      // and the lifecycle are wired up.
      const sent = await api(app).post(`${base}/messages`).set("Cookie", admin)
        .send({ content: "開啟 example.com", maxSteps: 3 }).expect(201);
      expect(sent.body).toMatchObject({ queued: true, interjected: false });

      await new Promise((r) => setTimeout(r, 2000));
      const after = await api(app).get(`${base}/session`).set("Cookie", admin).expect(200);
      const kinds = after.body.events.map((e: { type: string }) => e.type);
      expect(kinds).toContain("user_message");
      expect(kinds).toContain("run_started");
      expect(kinds).toContain("paused");
      expect(after.body.status).toBe("paused");
      const userMessage = after.body.events.find((e: { type: string }) => e.type === "user_message");
      expect(userMessage).toMatchObject({ content: "開啟 example.com", interjected: false });
      const paused = after.body.events.find((e: { type: string }) => e.type === "paused");
      expect(paused.reason).toBe("not_configured");
      expect(paused.message).toMatch(/自動接續/);

      // A message sent while it waits is queued as an interjection, not lost.
      const queued = await api(app).post(`${base}/messages`).set("Cookie", admin).send({ content: "再試一次" }).expect(201);
      expect(queued.body).toMatchObject({ interjected: true });
      const second = await api(app).get(`${base}/session`).set("Cookie", admin).expect(200);
      expect(second.body.events.filter((e: { type: string }) => e.type === "user_message")).toHaveLength(2);

      // A parked round is stoppable, so an outage never traps the conversation.
      expect((await api(app).post(`${base}/stop`).set("Cookie", admin).expect(201)).body).toEqual({ stopped: true });
      await new Promise((r) => setTimeout(r, 500));
      await api(app).delete(`${base}/session`).set("Cookie", admin).expect(200);
      const cleared = await api(app).get(`${base}/session`).set("Cookie", admin).expect(200);
      expect(cleared.body).toMatchObject({ turns: 0 });
      expect(cleared.body.events.map((e: { type: string }) => e.type)).not.toContain("user_message");

      await api(app).post(`${base}/messages`).set("Cookie", admin).send({ content: "  " }).expect(400);
    }, 60_000);

    it("streams the transcript over SSE and replays it on connect", async () => {
      await api(app).post(`/api/admin/sandbox/instances/${id}/agent/messages`).set("Cookie", admin)
        .send({ content: "串流測試" }).expect(201);
      await new Promise((r) => setTimeout(r, 1200));

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/sandbox/instances/${id}/agent/stream`, {
        headers: { cookie: admin },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 10_000;
      while (!text.includes("串流測試") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();

      expect(text).toContain(": connected");
      expect(text).toContain('"type":"user_message"');
      expect(text).toContain("串流測試");
      // Replay includes the whole round, not just the newest event.
      expect(text).toContain('"type":"run_started"');
    }, 60_000);

    it("stops and removes the sandbox", async () => {
      await api(app).delete(`/api/admin/sandbox/instances/${id}`).set("Cookie", admin).expect(200);
      await api(app).get(`/api/admin/sandbox/instances/${id}`).set("Cookie", admin).expect(404);
      const list = await api(app).get("/api/admin/sandbox/instances").set("Cookie", admin).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).not.toContain(id);
    }, 60_000);

    it("records start and stop in the audit log", async () => {
      const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining([
        "sandbox.start", "sandbox.stop", "sandbox.action", "sandbox.agent.message", "sandbox.agent.stop",
      ]));
    });
  });
});
