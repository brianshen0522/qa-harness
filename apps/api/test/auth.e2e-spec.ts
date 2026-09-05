import { INestApplication } from "@nestjs/common";
import { api, createApp, loginAdmin, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";

describe("auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
  });
  afterAll(() => app.close());

  it("rejects anonymous access to user and admin routes", async () => {
    await api(app).get("/api/auth/me").expect(401);
    await api(app).get("/api/projects").expect(401);
    await api(app).get("/api/admin/users").expect(401);
    await api(app).get("/api/admin/llm/configs").expect(401);
  });

  it("dev-login creates a user and sets an httpOnly cookie", async () => {
    const cookie = await loginUser(app, "alice@test.local", "Alice");
    expect(cookie).toMatch(/^qa_user=/);
    const me = await api(app).get("/api/auth/me").set("Cookie", cookie).expect(200);
    expect(me.body).toMatchObject({ kind: "user", email: "alice@test.local", name: "Alice" });
  });

  it("disabled users cannot log in or use an existing session", async () => {
    const cookie = await loginUser(app, "bob@test.local");
    await prisma.user.update({ where: { email: "bob@test.local" }, data: { status: "disabled" } });
    await api(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
    await api(app).post("/api/auth/dev-login").send({ email: "bob@test.local" }).expect(401);
  });

  it("admin is a role on the user identity: one login, admin flag gates the admin area", async () => {
    // Admins log in the same way; /auth/me exposes the flag and the same cookie
    // reaches both the app and the admin area.
    const adminCookie = await loginAdmin(app, prisma);
    const me = await api(app).get("/api/auth/me").set("Cookie", adminCookie).expect(200);
    expect(me.body.isAdmin).toBe(true);
    await api(app).get("/api/admin/users").set("Cookie", adminCookie).expect(200);
    await api(app).get("/api/projects").set("Cookie", adminCookie).expect(200);

    // A normal user authenticates fine but is forbidden from the admin area.
    const userCookie = await loginUser(app, "carol@test.local");
    const cme = await api(app).get("/api/auth/me").set("Cookie", userCookie).expect(200);
    expect(cme.body.isAdmin).toBe(false);
    await api(app).get("/api/admin/users").set("Cookie", userCookie).expect(403);

    // Unauthenticated is rejected outright.
    await api(app).get("/api/admin/users").expect(401);
  });

  it("logout clears the cookie", async () => {
    const cookie = await loginUser(app, "dave@test.local");
    const res = await api(app).post("/api/auth/logout").set("Cookie", cookie).expect(201);
    expect(String(res.headers["set-cookie"])).toMatch(/qa_user=;/);
  });
});
