import { INestApplication } from "@nestjs/common";
import { api, closeFetchPool, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";

/** §Dashboard: /me/overview + /me/runs aggregate a user's OWN targets, and nobody else's. */
describe("me / dashboard (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, outsider: string;
  let targetId: string, ownerId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    owner = await loginUser(app, "owner@me.local");
    outsider = await loginUser(app, "outsider@me.local");
    ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: "owner@me.local" } })).id;

    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId: team.body.id, name: "P", description: "d" }).expect(201);
    const target = await api(app).post(`/api/projects/${project.body.id}/targets`).set("Cookie", owner)
      .send({ name: "API", kind: "api", config: { base_url: "http://127.0.0.1:1" }, description: "d" }).expect(201);
    targetId = target.body.id;

    // Seed: one failed run, an outdated case, one open + one dismissed finding.
    const run = await prisma.testRun.create({ data: { targetId, status: "failed", triggeredById: ownerId, endedAt: new Date() } });
    const kase = await prisma.testCase.create({ data: { targetId, title: "c", expected: "x", steps: [], status: "outdated" } });
    await prisma.testResult.create({ data: { runId: run.id, testCaseId: kase.id, caseVersion: 1, verdict: "fail", llmReasoning: "r" } });
    await prisma.runFinding.create({ data: { runId: run.id, severity: "critical", title: "open one", status: "open" } });
    await prisma.runFinding.create({ data: { runId: run.id, severity: "minor", title: "closed one", status: "dismissed" } });
  });

  afterAll(async () => {
    await app.close();
    await closeFetchPool();
  });

  it("overview aggregates the owner's target with correct counts", async () => {
    const r = await api(app).get("/api/me/overview").set("Cookie", owner).expect(200);
    expect(r.body.totals.openFindings).toBe(1); // dismissed one is excluded
    expect(r.body.totals.outdatedCases).toBe(1);
    expect(r.body.totals.failingTargets).toBe(1);
    const t = r.body.targets.find((x: { id: string }) => x.id === targetId);
    expect(t.openFindings).toBe(1);
    expect(t.outdatedCases).toBe(1);
    expect(t.lastRun.verdicts.fail).toBe(1);
  });

  it("does not leak another user's targets or runs (cross-tenant)", async () => {
    const runs = await api(app).get("/api/me/runs").set("Cookie", outsider).expect(200);
    expect(runs.body).toEqual([]);
    const ov = await api(app).get("/api/me/overview").set("Cookie", outsider).expect(200);
    expect(ov.body.targets).toEqual([]);
    expect(ov.body.totals.openFindings).toBe(0);
  });

  it("findings inbox: owner reads + filters; a non-member is forbidden", async () => {
    const all = await api(app).get(`/api/targets/${targetId}/findings`).set("Cookie", owner).expect(200);
    expect(all.body).toHaveLength(2);
    const open = await api(app).get(`/api/targets/${targetId}/findings?status=open`).set("Cookie", owner).expect(200);
    expect(open.body).toHaveLength(1);
    expect(open.body[0].title).toBe("open one");
    const crit = await api(app).get(`/api/targets/${targetId}/findings?severity=critical`).set("Cookie", owner).expect(200);
    expect(crit.body).toHaveLength(1);
    // A user with no access is refused.
    await api(app).get(`/api/targets/${targetId}/findings`).set("Cookie", outsider).expect(404);
    await api(app).get("/api/me/overview").expect(401);
  });
});
