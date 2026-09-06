import { INestApplication } from "@nestjs/common";
import { api, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { TargetsService } from "../src/targets/targets.service";

/** Typed/paired credentials: a login is one named unit (username+password) with a
 *  description the model reads; editing covers value/type/rename/rotation/delete,
 *  and a rename rewrites the {{refs}} that would otherwise dangle. */
describe("target credential editing (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let targets: TargetsService;
  let owner: string;
  let targetId: string;
  let featureId: string;

  const decrypted = () => targets.decryptedCredentials(targetId);

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    targets = app.get(TargetsService);
    owner = await loginUser(app, "owner@cred.local");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId: team.body.id, name: "P", description: "d" }).expect(201);
    const target = await api(app).post(`/api/projects/${project.body.id}/targets`).set("Cookie", owner)
      .send({ name: "API", kind: "api", config: { base_url: "http://127.0.0.1:1" } }).expect(201);
    targetId = target.body.id;
    const feature = await api(app).post(`/api/targets/${targetId}/features`).set("Cookie", owner).send({ name: "F", description: "d" }).expect(201);
    featureId = feature.body.id;
  });

  afterAll(async () => { await app.close(); });

  it("creates a paired (username+password) login with a description and exposes .username/.password refs", async () => {
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner)
      .send({ name: "一般使用者", type: "password", description: "一般會員，登入後看 Browse", fields: { username: "qauser", password: "s3cret" } }).expect(200);
    const t = await api(app).get(`/api/targets/${targetId}`).set("Cookie", owner).expect(200);
    expect(t.body.credentials).toEqual([
      expect.objectContaining({ name: "一般使用者", type: "password", description: "一般會員，登入後看 Browse", fields: ["username", "password"], refs: ["一般使用者.username", "一般使用者.password"] }),
    ]);
    // Values never leave the server.
    expect(JSON.stringify(t.body)).not.toContain("qauser");
    expect(JSON.stringify(t.body)).not.toContain("s3cret");
    // But they expand to the {{ref}} map the run/crawler use.
    expect(await decrypted()).toEqual({ "一般使用者.username": "qauser", "一般使用者.password": "s3cret" });
  });

  it("reveals current field values for editing (owner only), and audits it", async () => {
    const r = await api(app).get(`/api/targets/${targetId}/credentials/${encodeURIComponent("一般使用者")}/reveal`).set("Cookie", owner).expect(200);
    expect(r.body).toMatchObject({ name: "一般使用者", type: "password", fields: { username: "qauser", password: "s3cret" } });
    const log = await prisma.auditLog.findFirst({ where: { action: "target.credential.reveal" }, orderBy: { createdAt: "desc" } });
    expect(log).not.toBeNull();
  });

  it("accepts the legacy { key, value } body as a single 'other' secret", async () => {
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner).send({ key: "api_token", value: "tok-123" }).expect(200);
    const t = await api(app).get(`/api/targets/${targetId}`).set("Cookie", owner).expect(200);
    expect(t.body.credentials).toContainEqual(expect.objectContaining({ name: "api_token", type: "other", refs: ["api_token"] }));
    expect((await decrypted())["api_token"]).toBe("tok-123");
  });

  it("toggles allowRotation and reports the rotatable ref (the password, not the username)", async () => {
    await api(app).patch(`/api/targets/${targetId}/credentials/一般使用者`).set("Cookie", owner).send({ allowRotation: true }).expect(200);
    const t = await api(app).get(`/api/targets/${targetId}`).set("Cookie", owner).expect(200);
    const cred = t.body.credentials.find((c: { name: string }) => c.name === "一般使用者");
    expect(cred).toMatchObject({ allowRotation: true, rotatableRef: "一般使用者.password" });
  });

  it("updates only the password of a login, keeping the username", async () => {
    await api(app).patch(`/api/targets/${targetId}/credentials/一般使用者`).set("Cookie", owner).send({ fields: { password: "new-pass" } }).expect(200);
    expect(await decrypted()).toMatchObject({ "一般使用者.username": "qauser", "一般使用者.password": "new-pass" });
  });

  it("renames a credential and rewrites {{name.field}} refs in setup flows and identities", async () => {
    await api(app).put(`/api/targets/${targetId}/api-setup`).set("Cookie", owner)
      .send({ steps: [{ label: "login", request: { method: "POST", path: "/login", body: { u: "{{一般使用者.username}}", p: "{{一般使用者.password}}" } }, captures: [] }] }).expect(200);
    await api(app).put(`/api/features/${featureId}/api-setup`).set("Cookie", owner)
      .send({ steps: [{ label: "seed", request: { method: "POST", path: "/seed", body: { pw: "{{一般使用者.password}}" } }, captures: [] }] }).expect(200);
    const identity = await prisma.targetIdentity.create({
      data: { targetId, name: "user", role: "member", credentialKeys: ["一般使用者.username", "一般使用者.password"], loginConfig: { passKey: "一般使用者.password" } },
    });

    await api(app).patch(`/api/targets/${targetId}/credentials/一般使用者`).set("Cookie", owner).send({ newKey: "member" }).expect(200);

    const t = await api(app).get(`/api/targets/${targetId}`).set("Cookie", owner).expect(200);
    expect(t.body.credentials.find((c: { name: string }) => c.name === "member")).toMatchObject({ refs: ["member.username", "member.password"] });

    const targetSetup = await api(app).get(`/api/targets/${targetId}/api-setup`).set("Cookie", owner).expect(200);
    expect(JSON.stringify(targetSetup.body)).toContain("{{member.username}}");
    expect(JSON.stringify(targetSetup.body)).toContain("{{member.password}}");
    expect(JSON.stringify(targetSetup.body)).not.toContain("一般使用者");
    const featureSetup = await api(app).get(`/api/features/${featureId}/api-setup`).set("Cookie", owner).expect(200);
    expect(JSON.stringify(featureSetup.body)).toContain("{{member.password}}");

    const refreshed = await prisma.targetIdentity.findUniqueOrThrow({ where: { id: identity.id } });
    expect(refreshed.credentialKeys).toEqual(["member.username", "member.password"]);
    expect(JSON.stringify(refreshed.loginConfig)).toContain("member.password");
    // Values survived the rename.
    expect(await decrypted()).toMatchObject({ "member.username": "qauser", "member.password": "new-pass" });
  });

  it("rejects a rename that collides, and a name containing a dot", async () => {
    await api(app).patch(`/api/targets/${targetId}/credentials/member`).set("Cookie", owner).send({ newKey: "api_token" }).expect(409);
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner)
      .send({ name: "bad.name", type: "other", fields: { value: "x" } }).expect(400);
  });

  it("drops a deleted credential's refs (all fields) from identities that used it", async () => {
    const idn = await prisma.targetIdentity.create({
      data: { targetId, name: "svc", role: "service", credentialKeys: ["member.username", "member.password", "api_token"], loginConfig: {} },
    });
    await api(app).delete(`/api/targets/${targetId}/credentials/member`).set("Cookie", owner).expect(200);
    const after = await prisma.targetIdentity.findUniqueOrThrow({ where: { id: idn.id } });
    expect(after.credentialKeys).toEqual(["api_token"]); // both member.* refs removed, api_token kept
  });
});
