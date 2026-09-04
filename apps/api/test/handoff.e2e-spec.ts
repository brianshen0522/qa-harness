import { INestApplication } from "@nestjs/common";
import { api, createApp, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";

const WEB_DOC = `---
harness_version: 0.1.0
scope: target
target_kind: web
generated_at: 2026-09-04T00:00:00.000Z
---

## Routes

- \`/login\` — 登入頁，不需登入
- \`/todos\` — 待辦清單，需登入

## Page Components

登入頁有 email 與密碼欄位、送出按鈕。

## Forms And Validation

email 必填且需符合格式；密碼至少 8 碼。

## Login Flow

在 /login 輸入測試帳號後導向 /todos。

## Selectors

- \`data-testid="login-submit"\`
- \`data-testid="todo-item"\`

## Suggested Test Cases

- 以有效帳號登入
  - 前往 /login
  - 輸入帳密並送出
  - Expected: 導向 /todos
`;

/** Spec §4.2: generate prompt → paste document → preview → apply. */
describe("context handoff (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: string, editor: string, viewer: string;
  let projectId: string, targetId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    owner = await loginUser(app, "owner@h.local", "Owner");
    editor = await loginUser(app, "editor@h.local", "Editor");
    viewer = await loginUser(app, "viewer@h.local", "Viewer");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner)
      .send({ teamId: team.body.id, name: "Shop", description: "原本的描述" }).expect(201);
    projectId = project.body.id;
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "editor@h.local", role: "editor" }).expect(201);
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "viewer@h.local", role: "viewer" }).expect(201);
    const target = await api(app).post(`/api/projects/${projectId}/targets`).set("Cookie", owner)
      .send({ name: "Shop Web", kind: "web" }).expect(201);
    targetId = target.body.id;
  });
  afterAll(() => app.close());

  it("generates a scope-aware prompt any member can copy", async () => {
    const p = await api(app).get(`/api/projects/${projectId}/handoff/prompt`).set("Cookie", viewer).expect(200);
    expect(p.body.scope).toBe("project");
    expect(p.body.prompt).toContain("scope: project");
    expect(p.body.prompt).toContain("## Known Gaps");
    expect(p.body.prompt).toContain("原本的描述");
    expect(p.body.sections.map((s: { title: string }) => s.title)).toContain("Suggested Test Cases");

    const t = await api(app).get(`/api/targets/${targetId}/handoff/prompt`).set("Cookie", viewer).expect(200);
    expect(t.body.kind).toBe("web");
    expect(t.body.prompt).toContain("target_kind: web");
    expect(t.body.prompt).toContain("## Selectors");
    expect(t.body.prompt).not.toContain("## Endpoints");
  });

  it("previews without writing anything", async () => {
    const before = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
    const r = await api(app).post(`/api/targets/${targetId}/handoff/preview`).set("Cookie", editor).send({ content: WEB_DOC }).expect(201);

    expect(r.body.unparsable).toBe(false);
    expect(r.body.missingSections).toEqual([]);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.recommendedMode).toBe("overwrite");
    expect(r.body.sections.selectors).toContain("login-submit");
    expect(r.body.suggestedTestCases).toEqual([
      { title: "以有效帳號登入", steps: ["前往 /login", "輸入帳密並送出"], expected: "導向 /todos" },
    ]);
    expect(r.body.renderedDescription).toContain("## Routes");
    expect(r.body.renderedDescription).not.toContain("Suggested Test Cases");

    const after = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
    expect(after.body.descriptionVersion).toBe(before.body.descriptionVersion);
    expect(await prisma.handoffDocument.count()).toBe(0);
  });

  it("viewers cannot preview or import", async () => {
    await api(app).post(`/api/targets/${targetId}/handoff/preview`).set("Cookie", viewer).send({ content: WEB_DOC }).expect(403);
    await api(app).post(`/api/targets/${targetId}/handoff/import`).set("Cookie", viewer).send({ content: WEB_DOC, mode: "overwrite" }).expect(403);
  });

  it("import overwrite writes a new version tagged handoff and keeps the raw document", async () => {
    const r = await api(app).post(`/api/targets/${targetId}/handoff/import`).set("Cookie", editor)
      .send({ content: WEB_DOC, mode: "overwrite" }).expect(201);
    expect(r.body.document.appliedToDescriptionVersion).toBe(1);
    expect(r.body.document.applyMode).toBe("overwrite");

    const target = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
    expect(target.body.description).toContain("## Routes");
    expect(target.body.descriptionVersion).toBe(1);

    const doc = await prisma.handoffDocument.findFirstOrThrow();
    expect(doc.rawContent).toBe(WEB_DOC);
    expect(doc.harnessVersion).toBe("0.1.0");
    expect((doc.parsed as { suggestedTestCases: unknown[] }).suggestedTestCases).toHaveLength(1);
  });

  it("merge keeps the existing description and appends the new one", async () => {
    const r = await api(app).post(`/api/projects/${projectId}/handoff/import`).set("Cookie", editor)
      .send({ content: "## Product Goal\n\n購物網站\n", mode: "merge" }).expect(201);
    const project = await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer).expect(200);
    expect(project.body.description).toContain("原本的描述");
    expect(project.body.description).toContain("購物網站");
    expect(project.body.descriptionVersion).toBe(r.body.document.appliedToDescriptionVersion);

    const versions = await api(app).get(`/api/projects/${projectId}/description/versions`).set("Cookie", viewer).expect(200);
    expect(versions.body[0].source).toBe("handoff");
  });

  it("flags suspected credentials without echoing their values", async () => {
    const withSecret = WEB_DOC.replace("## Login Flow\n", "## Login Flow\n\npassword: hunter2secret\n");
    const r = await api(app).post(`/api/targets/${targetId}/handoff/preview`).set("Cookie", editor).send({ content: withSecret }).expect(201);
    expect(r.body.detectedSecrets).toHaveLength(1);
    expect(r.body.detectedSecrets[0]).toMatchObject({ key: "password" });
    expect(JSON.stringify(r.body.detectedSecrets)).not.toContain("hunter2secret");
    // §4.2: the credential must not survive into the description that gets fed to the LLM.
    expect(r.body.renderedDescription).not.toContain("hunter2secret");
    expect(r.body.renderedDescription).toContain("已移除：請改存到加密憑證欄位");
  });

  it("an imported description never carries a detected credential, but the raw document is kept", async () => {
    const withSecret = WEB_DOC.replace("## Login Flow\n", "## Login Flow\n\npassword: hunter2secret\n");
    await api(app).post(`/api/targets/${targetId}/handoff/import`).set("Cookie", editor)
      .send({ content: withSecret, mode: "overwrite" }).expect(201);
    const target = await api(app).get(`/api/targets/${targetId}`).set("Cookie", viewer).expect(200);
    expect(target.body.description).not.toContain("hunter2secret");
    expect(target.body.description).toContain("已移除：請改存到加密憑證欄位");
    const doc = await prisma.handoffDocument.findFirstOrThrow({ orderBy: { importedAt: "desc" } });
    expect(doc.rawContent).toContain("hunter2secret");
  });

  it("warns on mismatched scope/kind and lists missing sections", async () => {
    const r = await api(app).post(`/api/targets/${targetId}/handoff/preview`).set("Cookie", editor)
      .send({ content: "---\nscope: project\ntarget_kind: api\n---\n\n## Routes\n\n/a\n" }).expect(201);
    expect(r.body.warnings.join(" ")).toMatch(/scope/);
    expect(r.body.warnings.join(" ")).toMatch(/target_kind/);
    expect(r.body.missingSections).toEqual(
      expect.arrayContaining(["Page Components", "Forms And Validation", "Login Flow", "Selectors"]),
    );
  });

  it("an unparsable document falls back to being kept as an attachment", async () => {
    const prose = "這台機器的登入方式我記不太清楚了，之後再補。";
    const preview = await api(app).post(`/api/projects/${projectId}/handoff/preview`).set("Cookie", editor).send({ content: prose }).expect(201);
    expect(preview.body.unparsable).toBe(true);
    expect(preview.body.recommendedMode).toBe("attachment");

    await api(app).post(`/api/projects/${projectId}/handoff/import`).set("Cookie", editor).send({ content: prose, mode: "overwrite" }).expect(400);

    const versionBefore = (await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer)).body.descriptionVersion;
    const r = await api(app).post(`/api/projects/${projectId}/handoff/import`).set("Cookie", editor).send({ content: prose, mode: "attachment" }).expect(201);
    expect(r.body.document.appliedToDescriptionVersion).toBeNull();

    const after = await api(app).get(`/api/projects/${projectId}`).set("Cookie", viewer).expect(200);
    expect(after.body.descriptionVersion).toBe(versionBefore);
    const attachments = await api(app).get(`/api/projects/${projectId}/attachments`).set("Cookie", viewer).expect(200);
    expect(attachments.body[0]).toMatchObject({ sourceType: "handoff", mime: "text/markdown" });
  });

  it("lists imported documents per scope and returns one in full", async () => {
    const list = await api(app).get(`/api/targets/${targetId}/handoff/documents`).set("Cookie", viewer).expect(200);
    expect(list.body).toHaveLength(2); // the clean import plus the redacted one
    expect(list.body.every((d: { scope: string; applyMode: string }) => d.scope === "target" && d.applyMode === "overwrite")).toBe(true);
    expect(list.body[0].importedAt >= list.body[1].importedAt).toBe(true); // newest first

    const projectDocs = await api(app).get(`/api/projects/${projectId}/handoff/documents`).set("Cookie", viewer).expect(200);
    expect(projectDocs.body.map((d: { applyMode: string }) => d.applyMode).sort()).toEqual(["attachment", "merge"]);

    const full = await api(app).get(`/api/handoff/documents/${list.body[1].id}`).set("Cookie", viewer).expect(200);
    expect(full.body.rawContent).toContain("## Selectors");
  });

  it("import is blocked while the target is running", async () => {
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "running" } });
    await api(app).post(`/api/targets/${targetId}/handoff/import`).set("Cookie", editor).send({ content: WEB_DOC, mode: "overwrite" }).expect(409);
    await prisma.qaTarget.update({ where: { id: targetId }, data: { status: "idle" } });
  });

  it("writes an audit entry for each import", async () => {
    const actions = (await prisma.auditLog.findMany({ where: { action: "handoff.import" } }));
    expect(actions.length).toBeGreaterThanOrEqual(3);
  });
});
