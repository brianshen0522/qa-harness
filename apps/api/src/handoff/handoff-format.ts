import type { TargetKind } from "@prisma/client";
import { HARNESS_VERSION } from "../config/version";

export type HandoffScope = "project" | "target";

export interface SectionSpec {
  /** Canonical section title the coding agent must emit. */
  title: string;
  /** Key used in the parsed payload. */
  key: string;
  /** What the agent should put there. */
  ask: string;
}

const SUGGESTED_CASES: SectionSpec = {
  title: "Suggested Test Cases",
  key: "suggested_test_cases",
  ask: "建議的 test case 清單。每條用 `- ` 開頭寫標題，下一層 `- ` 寫步驟，最後一行寫 `Expected: …`。",
};

const PROJECT_SECTIONS: SectionSpec[] = [
  { title: "Product Goal", key: "product_goal", ask: "這個產品的目標與目標使用者。" },
  { title: "Modules", key: "modules", ask: "模組清單，每個模組一行，說明職責。" },
  { title: "User Roles", key: "user_roles", ask: "使用者角色與各自權限。" },
  { title: "Main Flows", key: "main_flows", ask: "主要使用流程，依序列出步驟。" },
  { title: "Tech Stack", key: "tech_stack", ask: "前端、後端、資料庫、佇列、部署方式。" },
  { title: "Dev Environment", key: "dev_environment", ask: "dev 環境網址、啟動方式、種子資料、如何取得測試帳號。" },
  { title: "Known Gaps", key: "known_gaps", ask: "已知未完成或不穩定的項目，QA 應該略過或特別注意的部分。" },
  SUGGESTED_CASES,
];

const TARGET_SECTIONS: Record<TargetKind, SectionSpec[]> = {
  api: [
    { title: "Endpoints", key: "endpoints", ask: "每個 endpoint 一行：`METHOD /path` — 參數、成功回應、錯誤碼。" },
    { title: "Authentication", key: "auth", ask: "認證方式（token / basic / oauth）與 header 格式。" },
    { title: "Test Accounts", key: "test_accounts", ask: "測試帳號如何取得。**不要寫出真實密碼或 token**，只說明取得方式與欄位名稱。" },
    { title: "Data Dependencies", key: "data_dependencies", ask: "呼叫順序相依：哪些 endpoint 必須先建立資料。" },
    SUGGESTED_CASES,
  ],
  web: [
    { title: "Routes", key: "routes", ask: "路由表：路徑 — 頁面用途 — 是否需登入。" },
    { title: "Page Components", key: "page_components", ask: "各頁主要元件與可執行的操作。" },
    { title: "Forms And Validation", key: "forms", ask: "表單欄位、必填、格式限制與錯誤訊息。" },
    { title: "Login Flow", key: "login_flow", ask: "登入流程步驟。**不要寫出真實密碼**。" },
    { title: "Selectors", key: "selectors", ask: "關鍵 selector 或 data-testid，對應到哪個元件。" },
    SUGGESTED_CASES,
  ],
  desktop: [
    { title: "Launch", key: "launch", ask: "安裝指令或 image 名稱、啟動命令。" },
    { title: "Window Structure", key: "window_structure", ask: "主視窗、對話框、選單結構。" },
    { title: "Main Flows", key: "main_flows", ask: "主要操作路徑。" },
    SUGGESTED_CASES,
  ],
};

export function sectionsFor(scope: HandoffScope, kind?: TargetKind | null): SectionSpec[] {
  return scope === "project" ? PROJECT_SECTIONS : TARGET_SECTIONS[kind ?? "web"];
}

export interface PromptContext {
  scope: HandoffScope;
  kind?: TargetKind | null;
  projectName: string;
  targetName?: string;
  existingDescription?: string;
  /** §4.2 增量模式: the previous handoff, so the agent reports only what changed. */
  previousHandoff?: string;
}

/** Spec §4.2: the prompt the user pastes into their coding agent. */
export function buildHandoffPrompt(ctx: PromptContext): string {
  const sections = sectionsFor(ctx.scope, ctx.kind);
  const subject =
    ctx.scope === "project"
      ? `專案「${ctx.projectName}」`
      : `專案「${ctx.projectName}」底下的 QA Target「${ctx.targetName}」（種類：${ctx.kind}）`;

  const incremental = !!ctx.previousHandoff?.trim();
  const lines: string[] = [
    `你正在協助一個 QA 系統（QA Harness）建立對 ${subject} 的理解。`,
    incremental
      ? `這是「增量更新」：下面附上上一次的交接文件，請你比對程式碼現況，只回報「有變動的部分」——新增、修改、移除的 endpoint / 路由 / 表單 / 流程等。沒變的東西不要重覆抄。`
      : `請閱讀這個 repo 的實際程式碼，回報下列資訊。回答的依據必須是程式碼現況，不要臆測；不確定的地方寫「不確定」並說明原因。`,
    "",
    "## 輸出格式（必須嚴格遵守）",
    "",
    "回覆一份 Markdown 文件，開頭是 YAML front-matter，接著是固定標題的 section。除了文件本身不要有其他文字。",
    "",
    "```markdown",
    "---",
    `harness_version: ${HARNESS_VERSION}`,
    `scope: ${ctx.scope}`,
    ...(ctx.scope === "target" ? [`target_kind: ${ctx.kind}`] : []),
    `generated_at: ${new Date().toISOString()}`,
    "---",
    "",
    ...sections.flatMap((s) => [`## ${s.title}`, "", `（${s.ask}）`, ""]),
    "```",
    "",
    "## 各 section 要寫什麼",
    "",
    ...sections.map((s) => `- **${s.title}**：${s.ask}`),
    "",
    "## 注意事項",
    "",
    "- section 標題必須逐字使用上面的英文標題，內容可以用中文。",
    "- 沒有資料的 section 保留標題，內容寫「不確定」或「無」。",
    "- **不要寫出任何真實密碼、token、API key**。需要憑證的地方只描述欄位名稱與取得方式，QA 系統會另外用加密欄位保存。",
  ];

  if (incremental) {
    lines.push(
      "",
      "## 上一次的交接文件（請以程式碼為準，只回報與此不同之處）",
      "",
      "```markdown",
      ctx.previousHandoff!.trim().slice(0, 12000),
      "```",
      "",
      "在每個有變動的 section 裡，明確標出「新增 / 修改 / 移除」以及變動內容；完全沒變動的 section 內容寫「無變動」。",
    );
  }

  if (!incremental && ctx.existingDescription?.trim()) {
    lines.push(
      "",
      "## 目前 QA 系統中的描述（可能過時，請以程式碼為準並指出差異）",
      "",
      "```markdown",
      ctx.existingDescription.trim().slice(0, 4000),
      "```",
    );
  }
  return lines.join("\n");
}

// ---------- parsing ----------

export interface ParsedSuggestedCase {
  title: string;
  steps: string[];
  expected?: string;
}

export interface DetectedSecret {
  key: string;
  line: number;
  preview: string;
}

export interface ParsedHandoff {
  frontMatter: Record<string, string>;
  /** Canonical key -> markdown body, for recognised sections. */
  sections: Record<string, string>;
  /** Section titles that were not recognised, kept verbatim. */
  unknownSections: Record<string, string>;
  suggestedTestCases: ParsedSuggestedCase[];
  detectedSecrets: DetectedSecret[];
  /** Canonical sections that are missing or empty. */
  missingSections: string[];
  /** True when nothing recognisable was found; caller should fall back to "attachment". */
  unparsable: boolean;
  warnings: string[];
}

const FRONT_MATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Coding agents routinely wrap the whole document in a ```markdown fence.
 * Strip one such wrapper before parsing so the front-matter is still found.
 */
export function stripOuterFence(md: string): string {
  const t = md.trim();
  if (!/^```[a-z]*\r?\n/i.test(t)) return md;
  const closed = t.match(/^```[a-z]*\r?\n([\s\S]*?)\r?\n?```$/i);
  if (closed) return closed[1];
  // Models often open the wrapper and never close it; drop the opening line anyway.
  return t.replace(/^```[a-z]*\r?\n/i, "");
}

export function parseFrontMatter(md: string): { frontMatter: Record<string, string>; body: string } {
  const m = md.match(FRONT_MATTER_RE);
  if (!m) return { frontMatter: {}, body: md };
  const frontMatter: Record<string, string> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontMatter[key] = value;
  }
  return { frontMatter, body: md.slice(m[0].length) };
}

/** Titles are matched loosely: case, punctuation and spacing are ignored. */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^#{2,3}\s+(.+?)\s*$/gm;
  const heads: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) heads.push({ title: m[1], start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const next = i + 1 < heads.length ? heads[i + 1].start : body.length;
    out[heads[i].title] = body.slice(heads[i].end, next).trim();
  }
  return out;
}

/** Placeholder text the prompt itself suggests; treated as "not answered". */
function isPlaceholder(body: string): boolean {
  const t = body.replace(/[（）()\s]/g, "");
  return t === "" || /^(不確定|無|n\/a|na|tbd|todo|unknown)$/i.test(t);
}

export function parseSuggestedCases(body: string): ParsedSuggestedCase[] {
  const cases: ParsedSuggestedCase[] = [];
  let current: ParsedSuggestedCase | null = null;
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "  ").length;
    const bullet = raw.trim().match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    const text = bullet ? bullet[1].trim() : raw.trim();
    const expected = text.match(/^(?:expected|預期|預期結果)\s*[:：]\s*(.*)$/i);

    if (expected && current) {
      current.expected = expected[1].trim();
      continue;
    }
    if (bullet && indent === 0) {
      current = { title: text.replace(/^\*\*(.*)\*\*$/, "$1"), steps: [] };
      cases.push(current);
    } else if (bullet && current) {
      current.steps.push(text);
    } else if (current && !bullet) {
      const inlineExpected = text.match(/^(?:expected|預期)\b/i);
      if (inlineExpected) current.expected = text.replace(/^[^:：]*[:：]\s*/, "");
    }
  }
  return cases.filter((c) => c.title.length > 0).slice(0, 200);
}

const SECRET_KEY_RE =
  /\b(pass(?:word|wd)?|token|api[_-]?key|apikey|secret|credential|bearer|private[_-]?key|client[_-]?secret|access[_-]?key)\b/i;
/** A key/value pair whose value looks like an actual secret rather than a description. */
const SECRET_VALUE_RE = /[:=]\s*["'`]?([^\s"'`,;]{6,})["'`]?\s*$/;

export function detectSecrets(md: string): DetectedSecret[] {
  const out: DetectedSecret[] = [];
  const lines = md.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!SECRET_KEY_RE.test(line)) return;
    const v = line.match(SECRET_VALUE_RE);
    if (!v) return;
    const value = v[1];
    // Skip placeholders and prose like "password: 由管理者提供"
    if (/^(<.*>|\.\.\.|xxx+|\*+|null|none|n\/a|tbd|todo)$/i.test(value)) return;
    if (!/[A-Za-z0-9]/.test(value)) return;
    if (/^[一-鿿]+$/.test(value)) return;
    const keyMatch = line.match(SECRET_KEY_RE)!;
    out.push({
      key: keyMatch[0],
      line: i + 1,
      preview: `${line.trim().slice(0, Math.max(0, line.trim().indexOf(value)))}${value.slice(0, 2)}****`.slice(0, 120),
    });
  });
  return out.slice(0, 50);
}

export function parseHandoff(md: string, scope: HandoffScope, kind?: TargetKind | null): ParsedHandoff {
  const specs = sectionsFor(scope, kind);
  const byNorm = new Map(specs.map((s) => [normalizeTitle(s.title), s]));
  const source = stripOuterFence(md);
  const { frontMatter, body } = parseFrontMatter(source);
  const raw = splitSections(body);

  const sections: Record<string, string> = {};
  const unknownSections: Record<string, string> = {};
  for (const [title, content] of Object.entries(raw)) {
    const spec = byNorm.get(normalizeTitle(title));
    if (spec) sections[spec.key] = content;
    else unknownSections[title] = content;
  }

  const warnings: string[] = [];
  if (!Object.keys(frontMatter).length) warnings.push("找不到 YAML front-matter，已改用寬鬆解析。");
  if (frontMatter.scope && frontMatter.scope !== scope) {
    warnings.push(`文件的 scope 是「${frontMatter.scope}」，與目前頁面的「${scope}」不符。`);
  }
  if (scope === "target" && kind && frontMatter.target_kind && frontMatter.target_kind !== kind) {
    warnings.push(`文件的 target_kind 是「${frontMatter.target_kind}」，與這個 Target 的「${kind}」不符。`);
  }
  if (frontMatter.harness_version && frontMatter.harness_version !== HARNESS_VERSION) {
    warnings.push(`文件由 harness ${frontMatter.harness_version} 產生，目前為 ${HARNESS_VERSION}。`);
  }
  if (Object.keys(unknownSections).length) {
    warnings.push(`有 ${Object.keys(unknownSections).length} 個未知 section，將原樣保留為描述文字。`);
  }

  const suggestedTestCases = sections.suggested_test_cases
    ? parseSuggestedCases(sections.suggested_test_cases)
    : [];
  const missingSections = specs
    .filter((s) => !sections[s.key] || isPlaceholder(sections[s.key]))
    .map((s) => s.title);

  const recognised = Object.keys(sections).length;
  return {
    frontMatter,
    sections,
    unknownSections,
    suggestedTestCases,
    detectedSecrets: detectSecrets(source),
    missingSections,
    unparsable: recognised === 0,
    warnings,
  };
}

export const REDACTED_NOTE = "****（已移除：請改存到加密憑證欄位）";

/**
 * Spec §4.2: suspected credentials must not survive into the description, because
 * the description is fed to the LLM on every run. The original document is still
 * kept verbatim in `handoff_documents` for audit.
 */
export function redactSecrets(md: string): string {
  return md
    .split(/\r?\n/)
    .map((line) => {
      if (!SECRET_KEY_RE.test(line)) return line;
      const v = line.match(SECRET_VALUE_RE);
      if (!v) return line;
      const value = v[1];
      if (/^(<.*>|\.\.\.|xxx+|\*+|null|none|n\/a|tbd|todo)$/i.test(value)) return line;
      if (!/[A-Za-z0-9]/.test(value)) return line;
      if (/^[一-鿿]+$/.test(value)) return line;
      return line.slice(0, line.lastIndexOf(value)) + REDACTED_NOTE;
    })
    .join("\n");
}

/** Render the parsed document back into the markdown description stored on the entity. */
export function renderDescription(parsed: ParsedHandoff, scope: HandoffScope, kind?: TargetKind | null): string {
  const specs = sectionsFor(scope, kind);
  const parts: string[] = [];
  for (const spec of specs) {
    if (spec.key === "suggested_test_cases") continue; // seeds the generation pipeline, not the description
    const body = parsed.sections[spec.key];
    if (!body || isPlaceholder(body)) continue;
    parts.push(`## ${spec.title}\n\n${body.trim()}`);
  }
  for (const [title, body] of Object.entries(parsed.unknownSections)) {
    if (!body.trim()) continue;
    parts.push(`## ${title}\n\n${body.trim()}`);
  }
  return redactSecrets(parts.join("\n\n"));
}
