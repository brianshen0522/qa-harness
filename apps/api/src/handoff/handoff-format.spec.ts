import {
  buildHandoffPrompt, detectSecrets, parseFrontMatter, parseHandoff,
  parseSuggestedCases, redactSecrets, renderDescription, splitSections, stripOuterFence, REDACTED_NOTE,
} from "./handoff-format";

const API_DOC = `---
harness_version: 0.1.0
scope: target
target_kind: api
generated_at: 2026-09-04T00:00:00.000Z
---

## Endpoints

- \`POST /auth/login\` — body: email, password; 200 回傳 token；401 憑證錯誤
- \`GET /todos\` — 需要 Bearer token；200 回傳陣列

## Authentication

Bearer token，放在 Authorization header。

## Test Accounts

由 seed 腳本建立，帳號欄位為 email，密碼透過環境變數提供。

## Data Dependencies

必須先呼叫 /auth/login 取得 token，才能呼叫 /todos。

## Suggested Test Cases

- 使用正確帳密登入成功
  - 開啟登入 API
  - 送出正確帳密
  - Expected: 回傳 200 與 token
- 使用錯誤密碼登入失敗
  - 送出錯誤密碼
  - Expected: 回傳 401

## System Overview

一個待辦事項的後端 API,讓使用者登入後管理自己的 todo。核心功能:登入取得 token、列出/新增/完成待辦。

## User Roles

- 一般使用者:登入後管理自己的 todo(建立、列出、完成、刪除)。
- 匿名:只能呼叫登入,其它一律 401。
`;

describe("handoff front-matter", () => {
  it("parses key/value pairs and strips the block from the body", () => {
    const { frontMatter, body } = parseFrontMatter(API_DOC);
    expect(frontMatter).toMatchObject({ harness_version: "0.1.0", scope: "target", target_kind: "api" });
    expect(body.trimStart().startsWith("## Endpoints")).toBe(true);
  });

  it("returns the whole document when there is no front-matter", () => {
    const { frontMatter, body } = parseFrontMatter("## Endpoints\n\nhi");
    expect(frontMatter).toEqual({});
    expect(body).toBe("## Endpoints\n\nhi");
  });

  it("strips surrounding quotes from values", () => {
    const { frontMatter } = parseFrontMatter('---\nscope: "project"\n---\nbody');
    expect(frontMatter.scope).toBe("project");
  });
});

describe("handoff sections", () => {
  it("splits h2/h3 headings", () => {
    const s = splitSections("## A\n\nalpha\n\n### B\n\nbeta\n");
    expect(s).toEqual({ A: "alpha", B: "beta" });
  });

  it("matches canonical titles loosely (case, spacing, punctuation)", () => {
    const doc = "## endpoints\n\nE\n\n## Forms and validation\n\nF\n";
    const web = parseHandoff(doc, "target", "web");
    expect(web.sections.forms).toBe("F");
    expect(web.unknownSections.endpoints).toBe("E"); // not a web section
    const api = parseHandoff(doc, "target", "api");
    expect(api.sections.endpoints).toBe("E");
  });

  it("keeps unrecognised sections verbatim and warns", () => {
    const p = parseHandoff("## Endpoints\n\nE\n\n## Deployment Notes\n\nD\n", "target", "api");
    expect(p.unknownSections["Deployment Notes"]).toBe("D");
    expect(p.warnings.join()).toMatch(/未知 section/);
  });
});

describe("parseHandoff", () => {
  const parsed = parseHandoff(API_DOC, "target", "api");

  it("extracts every canonical section", () => {
    expect(Object.keys(parsed.sections).sort()).toEqual(
      ["auth", "data_dependencies", "endpoints", "suggested_test_cases", "system_overview", "test_accounts", "user_roles"].sort(),
    );
    expect(parsed.missingSections).toEqual([]);
    expect(parsed.unparsable).toBe(false);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses suggested test cases into title / steps / expected", () => {
    expect(parsed.suggestedTestCases).toEqual([
      { title: "使用正確帳密登入成功", steps: ["開啟登入 API", "送出正確帳密"], expected: "回傳 200 與 token" },
      { title: "使用錯誤密碼登入失敗", steps: ["送出錯誤密碼"], expected: "回傳 401" },
    ]);
  });

  it("flags placeholder sections as missing", () => {
    const p = parseHandoff("## Endpoints\n\n（不確定）\n\n## Authentication\n\n無\n", "target", "api");
    expect(p.missingSections).toEqual(
      expect.arrayContaining(["Endpoints", "Authentication", "Test Accounts", "Data Dependencies"]),
    );
  });

  it("warns when scope, kind or harness version disagree", () => {
    const p = parseHandoff(
      "---\nharness_version: 0.0.1\nscope: project\ntarget_kind: web\n---\n\n## Endpoints\n\nE\n",
      "target",
      "api",
    );
    expect(p.warnings.join(" ")).toMatch(/scope/);
    expect(p.warnings.join(" ")).toMatch(/target_kind/);
    expect(p.warnings.join(" ")).toMatch(/0\.0\.1/);
  });

  it("marks a document with no recognisable section as unparsable", () => {
    const p = parseHandoff("just some prose the agent wrote", "project");
    expect(p.unparsable).toBe(true);
  });

  it("numbered lists also work for suggested cases", () => {
    expect(parseSuggestedCases("1. 建立待辦\n   1. 按新增\n   2. Expected: 出現在清單")).toEqual([
      { title: "建立待辦", steps: ["按新增"], expected: "出現在清單" },
    ]);
  });
});

describe("secret detection (§4.2)", () => {
  it("finds credential-looking key/value pairs without echoing the value", () => {
    const found = detectSecrets(
      [
        "## Test Accounts",
        "email: qa@example.com",
        "password: hunter2secret",
        "api_key = sk-live-abcdef123456",
        "所有 token 都由 CI 注入",
        "password: 由管理者提供",
        "token: <your-token-here>",
      ].join("\n"),
    );
    expect(found.map((f) => f.key.toLowerCase())).toEqual(["password", "api_key"]);
    expect(found[0].line).toBe(3);
    expect(JSON.stringify(found)).not.toContain("hunter2secret");
    expect(JSON.stringify(found)).not.toContain("abcdef123456");
    expect(found[0].preview).toBe("password: hu****");
  });

  it("reports nothing for a clean document", () => {
    expect(detectSecrets(API_DOC)).toEqual([]);
  });
});

describe("renderDescription", () => {
  it("keeps canonical order, drops suggested cases and placeholders, appends unknown sections", () => {
    const p = parseHandoff(
      "## Authentication\n\nBearer\n\n## Endpoints\n\nE\n\n## Test Accounts\n\n不確定\n\n## Extra\n\nX\n\n## Suggested Test Cases\n\n- a\n",
      "target",
      "api",
    );
    const md = renderDescription(p, "target", "api");
    expect(md.indexOf("## Endpoints")).toBeLessThan(md.indexOf("## Authentication"));
    expect(md).not.toContain("Test Accounts");
    expect(md).not.toContain("Suggested Test Cases");
    expect(md).toContain("## Extra\n\nX");
  });
});

describe("buildHandoffPrompt", () => {
  it("includes front-matter, every section title, and the no-secrets rule", () => {
    const p = buildHandoffPrompt({ scope: "target", kind: "web", projectName: "Shop", targetName: "Web UI" });
    expect(p).toContain("scope: target");
    expect(p).toContain("target_kind: web");
    for (const t of ["Routes", "Page Components", "Forms And Validation", "Login Flow", "Selectors", "Suggested Test Cases"]) {
      expect(p).toContain(`## ${t}`);
    }
    expect(p).toMatch(/不要寫出任何真實密碼/);
    expect(p).not.toContain("Endpoints");
  });

  it("uses the project section set and embeds the existing description", () => {
    const p = buildHandoffPrompt({ scope: "project", projectName: "Shop", existingDescription: "舊的描述內容" });
    expect(p).toContain("## Known Gaps");
    expect(p).toContain("舊的描述內容");
    expect(p).not.toContain("target_kind");
  });
});

describe("wrapping code fences", () => {
  it("strips a ```markdown wrapper that coding agents commonly add", () => {
    expect(stripOuterFence("```markdown\n---\nscope: target\n---\n\n## Endpoints\n\nE\n```")).toContain("---\nscope: target");
    expect(stripOuterFence("## Endpoints\n\nE")).toBe("## Endpoints\n\nE");
  });

  it("still finds front-matter and sections inside the wrapper", () => {
    const p = parseHandoff("```markdown\n" + API_DOC + "```", "target", "api");
    expect(p.frontMatter.target_kind).toBe("api");
    expect(p.sections.endpoints).toContain("/auth/login");
    expect(p.unparsable).toBe(false);
  });

  it("recovers when the model opens the wrapper but never closes it", () => {
    const p = parseHandoff("```markdown\n" + API_DOC, "target", "api");
    expect(p.frontMatter.target_kind).toBe("api");
    expect(p.warnings).toEqual([]);
    expect(Object.keys(p.sections)).toHaveLength(7);
  });

  it("leaves inner fenced code blocks alone", () => {
    const p = parseHandoff("## Endpoints\n\n```http\nGET /todos\n```\n", "target", "api");
    expect(p.sections.endpoints).toContain("GET /todos");
  });
});

describe("credential redaction (§4.2: 不留在描述中)", () => {
  it("strips secret values out of the rendered description", () => {
    const doc = "## Test Accounts\n\ndemo@example.com\npassword: hunter2secret\n\n## Endpoints\n\nGET /todos\n";
    const p = parseHandoff(doc, "target", "api");
    const md = renderDescription(p, "target", "api");
    expect(p.detectedSecrets).toHaveLength(1);
    expect(md).not.toContain("hunter2secret");
    expect(md).toContain(REDACTED_NOTE);
    expect(md).toContain("demo@example.com");   // non-secret content survives
    expect(md).toContain("GET /todos");
  });

  it("leaves prose and placeholders untouched", () => {
    const md = "password: 由管理者提供\ntoken: <your-token>\n密碼從環境變數 SEED_PASSWORD 讀取";
    expect(redactSecrets(md)).toBe(md);
  });

  it("redacts every flagged line, keeping the key name visible", () => {
    const out = redactSecrets("api_key = sk-live-abcdef123456\nclient_secret: s3cr3tvalue");
    expect(out).not.toMatch(/abcdef123456|s3cr3tvalue/);
    expect(out).toContain("api_key = ");
    expect(out).toContain("client_secret: ");
  });
});
