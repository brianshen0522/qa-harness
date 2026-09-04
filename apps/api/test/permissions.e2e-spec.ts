import { INestApplication } from "@nestjs/common";
import { api, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Covers spec §2.2 (action matrix) and §2.3 (rules 1–6) end to end.
 */
describe("teams / projects / targets + permission rules (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string, outsider: string;
  let ownerId: string, editorId: string, viewerId: string;
  let teamId: string, projectId: string, targetId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    owner = await loginUser(app, "owner@test.local", "Owner");
    editor = await loginUser(app, "editor@test.local", "Editor");
    viewer = await loginUser(app, "viewer@test.local", "Viewer");
    outsider = await loginUser(app, "outsider@test.local", "Outsider");
    const users = await prisma.user.findMany();
    ownerId = users.find((u) => u.email === "owner@test.local")!.id;
    editorId = users.find((u) => u.email === "editor@test.local")!.id;
    viewerId = users.find((u) => u.email === "viewer@test.local")!.id;
  });
  afterAll(() => app.close());

  it("creates a team, a project (creator becomes owner) and adds members with roles", async () => {
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "Core" }).expect(201);
    teamId = team.body.id;

    // non-member cannot create a project in this team
    await api(app).post("/api/projects").set("Cookie", outsider).send({ teamId, name: "X" }).expect(404);

    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId, name: "Shop", description: "v1" }).expect(201);
    projectId = project.body.id;
    expect(project.body.descriptionVersion).toBe(1);

    const list = await api(app).get("/api/projects").set("Cookie", owner).expect(200);
    expect(list.body[0].myRole).toBe("owner");

    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "editor@test.local", role: "editor" }).expect(201);
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "viewer@test.local", role: "viewer" }).expect(201);
    // unknown email
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "ghost@test.local", role: "viewer" }).expect(404);
    // duplicate
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "viewer@test.local", role: "viewer" }).expect(400);
  });

  it("outsiders get 404 (no existence leak); viewers can read but not write", async () => {
    await api(app).get(`/api/projects/${projectId}`).set("Cookie", outsider).expect(404);
    await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer).expect(200);
    await api(app).put(`/api/projects/${projectId}/description`).set("Cookie", viewer).send({ content: "nope" }).expect(403);
    await api(app).get(`/api/projects/${projectId}/members`).set("Cookie", viewer).expect(200);
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", viewer).send({ email: "x@test.local", role: "viewer" }).expect(403);
  });

  it("editors can edit the description (new version) but not manage members or targets", async () => {
    const r = await api(app).put(`/api/projects/${projectId}/description`).set("Cookie", editor).send({ content: "v2 text" }).expect(200);
    expect(r.body.descriptionVersion).toBe(2);
    const versions = await api(app).get(`/api/projects/${projectId}/description/versions`).set("Cookie", viewer).expect(200);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", editor).send({ email: "viewer@test.local", role: "viewer" }).expect(403);
    await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", editor).send({ name: "API", kind: "api" }).expect(403);
    await api(app).patch(`/api/projects/${projectId}`).set("Cookie", editor).send({ name: "Renamed" }).expect(403);
  });

  it("owner creates a target; rule 1: project roles apply to the target by default", async () => {
    const t = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "Shop API", kind: "api", config: { base_url: "http://localhost:8080" } }).expect(201);
    targetId = t.body.id;

    expect((await api(app).get(`/api/targets/${targetId}`).set("Cookie", owner).expect(200)).body.myRole).toBe("owner");
    expect((await api(app).get(`/api/targets/${targetId}`).set("Cookie", editor).expect(200)).body.myRole).toBe("editor");
    expect((await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200)).body.myRole).toBe("viewer");
    await api(app).get(`/api/targets/${targetId}`).set("Cookie", outsider).expect(404);
  });

  it("target action matrix: viewer read-only, editor edits description, owner edits config/credentials", async () => {
    await api(app).put(`/api/targets/${targetId}/description`).set("Cookie", viewer).send({ content: "x" }).expect(403);
    await api(app).put(`/api/targets/${targetId}/description`).set("Cookie", editor).send({ content: "desc" }).expect(200);
    await api(app).patch(`/api/targets/${targetId}`).set("Cookie", editor).send({ name: "nope" }).expect(403);
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", editor).send({ key: "token", value: "s3cret" }).expect(403);

    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner).send({ key: "token", value: "s3cret" }).expect(200);
    const t = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
    expect(t.body.credentialKeys).toEqual(["token"]);
    expect(JSON.stringify(t.body)).not.toContain("s3cret");
    const row = await prisma.targetCredential.findUniqueOrThrow({ where: { targetId_key: { targetId, key: "token" } } });
    expect(row.encryptedValue).not.toContain("s3cret");
  });

  it("rule 2: target override can raise a role but not lower it", async () => {
    // raise viewer → editor on this target
    await api(app).put(`/api/targets/${targetId}/members/${viewerId}`).set("Cookie", owner).send({ role: "editor" }).expect(200);
    expect((await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200)).body.myRole).toBe("editor");
    await api(app).put(`/api/targets/${targetId}/description`).set("Cookie", viewer).send({ content: "now allowed" }).expect(200);
    // project-level role is unchanged
    expect((await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer).expect(200)).body.myRole).toBe("viewer");

    // lowering editor → viewer must be rejected
    const r = await api(app).put(`/api/targets/${targetId}/members/${editorId}`).set("Cookie", owner).send({ role: "viewer" }).expect(400);
    expect(r.body.message).toMatch(/cannot be lower/i);
  });

  it("rule 3: project owner cannot be overridden on a target", async () => {
    await api(app).put(`/api/targets/${targetId}/members/${ownerId}`).set("Cookie", owner).send({ role: "viewer" }).expect(400);
    await api(app).put(`/api/targets/${targetId}/members/${ownerId}`).set("Cookie", owner).send({ role: "owner" }).expect(400);
  });

  it("rule 4: only project members can receive a target role", async () => {
    const outsiderId = (await prisma.user.findUniqueOrThrow({ where: { email: "outsider@test.local" } })).id;
    const r = await api(app).put(`/api/targets/${targetId}/members/${outsiderId}`).set("Cookie", owner).send({ role: "viewer" }).expect(400);
    expect(r.body.message).toMatch(/not a member/i);
    // a target-level editor (viewer with override) still cannot manage members
    await api(app).put(`/api/targets/${targetId}/members/${editorId}`).set("Cookie", viewer).send({ role: "owner" }).expect(403);
  });

  it("rule 5: members list reports projectRole / targetRole / effectiveRole", async () => {
    const r = await api(app).get(`/api/targets/${targetId}/members`).set("Cookie", viewer).expect(200);
    const byEmail = Object.fromEntries(r.body.map((m: any) => [m.user.email, m]));
    expect(byEmail["owner@test.local"]).toMatchObject({ projectRole: "owner", targetRole: null, effectiveRole: "owner" });
    expect(byEmail["editor@test.local"]).toMatchObject({ projectRole: "editor", targetRole: null, effectiveRole: "editor" });
    expect(byEmail["viewer@test.local"]).toMatchObject({ projectRole: "viewer", targetRole: "editor", effectiveRole: "editor" });
    expect(byEmail["outsider@test.local"]).toBeUndefined();
  });

  it("raising a project role makes now-redundant overrides disappear", async () => {
    await api(app).patch(`/api/projects/${projectId}/members/${viewerId}`).set("Cookie", owner).send({ role: "editor" }).expect(200);
    const overrides = await prisma.targetMember.findMany({ where: { targetId, userId: viewerId } });
    expect(overrides).toHaveLength(0);
    // and set it back for the next test
    await api(app).patch(`/api/projects/${projectId}/members/${viewerId}`).set("Cookie", owner).send({ role: "viewer" }).expect(200);
    await api(app).put(`/api/targets/${targetId}/members/${viewerId}`).set("Cookie", owner).send({ role: "owner" }).expect(200);
    expect(await prisma.targetMember.count({ where: { targetId, userId: viewerId } })).toBe(1);
  });

  it("rule 6: removing a project member deletes their target overrides and access", async () => {
    await api(app).delete(`/api/projects/${projectId}/members/${viewerId}`).set("Cookie", owner).expect(200);
    expect(await prisma.targetMember.count({ where: { userId: viewerId } })).toBe(0);
    await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(404);
    await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer).expect(404);
  });

  it("the last owner cannot be demoted or removed", async () => {
    await api(app).patch(`/api/projects/${projectId}/members/${ownerId}`).set("Cookie", owner).send({ role: "editor" }).expect(400);
    await api(app).delete(`/api/projects/${projectId}/members/${ownerId}`).set("Cookie", owner).expect(400);
  });

  it("a running target locks config, credentials and description (409)", async () => {
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
    await api(app).patch(`/api/targets/${targetId}`).set("Cookie", owner).send({ name: "x" }).expect(409);
    await api(app).put(`/api/targets/${targetId}/credentials`).set("Cookie", owner).send({ key: "k", value: "v" }).expect(409);
    await api(app).put(`/api/targets/${targetId}/description`).set("Cookie", editor).send({ content: "x" }).expect(409);
    await api(app).delete(`/api/targets/${targetId}`).set("Cookie", owner).expect(409);
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
  });

  it("only owners delete targets and projects; deletes cascade", async () => {
    await api(app).delete(`/api/targets/${targetId}`).set("Cookie", editor).expect(403);
    await api(app).delete(`/api/targets/${targetId}`).set("Cookie", owner).expect(200);
    expect(await prisma.targetCredential.count({ where: { targetId } })).toBe(0);
    await api(app).delete(`/api/projects/${projectId}`).set("Cookie", editor).expect(403);
    await api(app).delete(`/api/projects/${projectId}`).set("Cookie", owner).expect(200);
    expect(await prisma.projectMember.count({ where: { projectId } })).toBe(0);
    expect(await prisma.projectDescriptionVersion.count({ where: { projectId } })).toBe(0);
  });

  it("writes an audit trail", async () => {
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([
      "project.create", "project.member.add", "target.create", "target.credential.set", "target.member.set", "project.member.remove", "target.delete", "project.delete",
    ]));
  });
});
