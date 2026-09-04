import { INestApplication } from "@nestjs/common";
import { api, createApp, loginAdmin, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { DockerService } from "../src/sandbox/docker.service";
import { SandboxService } from "../src/sandbox/sandbox.service";

/**
 * Spec §4.8: the admin must be able to start a sandbox and confirm the
 * environment works. These tests drive real containers, so they are skipped
 * when Docker or the sandbox image is unavailable.
 */
describe("admin sandbox (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let user: string;
  let dockerReady = false;
  const started: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    admin = await loginAdmin(app, prisma);
    user = await loginUser(app, "member@s.local");

    const docker = app.get(DockerService);
    const settings = await app.get(SandboxService).settings();
    dockerReady = (await docker.ping()).ok && (await docker.imageExists(settings.image));
    if (!dockerReady) {
      // eslint-disable-next-line no-console
      console.warn(`skipping container tests: docker or image ${settings.image} unavailable`);
    }
  }, 60_000);

  afterAll(async () => {
    const sandbox = app.get(SandboxService);
    await Promise.all(started.map((id) => sandbox.remove(id).catch(() => undefined)));
    await app.close();
  }, 60_000);

  it("is admin-only", async () => {
    await api(app).get("/api/admin/sandbox/status").expect(401);
    await api(app).get("/api/admin/sandbox/status").set("Cookie", user).expect(401);
    await api(app).post("/api/admin/sandbox/instances").set("Cookie", user).send({}).expect(401);
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

  describe("with a real container", () => {
    let id: string;

    it("starts a sandbox that is running, healthy and reachable", async () => {
      if (!dockerReady) return;
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
      if (!dockerReady) return;
      const list = await api(app).get("/api/admin/sandbox/instances").set("Cookie", admin).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).toContain(id);
      const status = await api(app).get("/api/admin/sandbox/status").set("Cookie", admin).expect(200);
      expect(status.body.running).toBeGreaterThanOrEqual(1);
    });

    it("captures the screen at the configured resolution", async () => {
      if (!dockerReady) return;
      const r = await api(app).get(`/api/admin/sandbox/instances/${id}/screenshot`).set("Cookie", admin).expect(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.image).toMatch(/^data:image\/png;base64,/);
      expect(r.body.width).toBe(1280);
      expect(r.body.height).toBe(800);
    }, 30_000);

    it("performs actions and reports failures without throwing", async () => {
      if (!dockerReady) return;
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
      if (!dockerReady) return;
      const r = await api(app).post(`/api/admin/sandbox/instances/${id}/actions`).set("Cookie", admin)
        .send({ action: "move", params: { x: 99999, y: -50 } }).expect(201);
      expect(r.body).toMatchObject({ ok: true, detail: { x: 1279, y: 0 } });
    }, 30_000);

    it("exposes container logs", async () => {
      if (!dockerReady) return;
      const r = await api(app).get(`/api/admin/sandbox/instances/${id}/logs?tail=50`).set("Cookie", admin).expect(200);
      expect(r.body.logs).toContain("[sandbox]");
      expect(r.body.logs).toContain("computer-use agent");
    }, 30_000);

    it("refuses to exceed the concurrency limit", async () => {
      if (!dockerReady) return;
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: 1 } });
      const r = await api(app).post("/api/admin/sandbox/instances").set("Cookie", admin).send({}).expect(400);
      expect(r.body.message).toMatch(/並行上限/);
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: 2 } });
    }, 60_000);

    it("reclaims an expired sandbox on sweep", async () => {
      if (!dockerReady) return;
      const sandbox = app.get(SandboxService);
      const docker = app.get(DockerService);
      // The daemon is shared with whatever else is running on this machine, so make
      // room rather than assuming the limit is free.
      const before = await prisma.sandboxSettings.findFirstOrThrow();
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: 99 } });
      const expired = await sandbox.create("admin-test-user", { ttlMinutes: 5 });
      started.push(expired.id);
      await docker.stopContainer(expired.id);
      const removed = await sandbox.sweep();
      expect(removed).toBeGreaterThanOrEqual(1);
      await api(app).get(`/api/admin/sandbox/instances/${expired.id}`).set("Cookie", admin).expect(404);
      await prisma.sandboxSettings.update({ where: { id: 1 }, data: { maxConcurrent: before.maxConcurrent } });
    }, 180_000);

    it("stops and removes the sandbox", async () => {
      if (!dockerReady) return;
      await api(app).delete(`/api/admin/sandbox/instances/${id}`).set("Cookie", admin).expect(200);
      await api(app).get(`/api/admin/sandbox/instances/${id}`).set("Cookie", admin).expect(404);
      const list = await api(app).get("/api/admin/sandbox/instances").set("Cookie", admin).expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).not.toContain(id);
    }, 60_000);

    it("records start and stop in the audit log", async () => {
      if (!dockerReady) return;
      const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["sandbox.start", "sandbox.stop", "sandbox.action"]));
    });
  });
});
