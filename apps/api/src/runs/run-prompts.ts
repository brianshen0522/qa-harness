import type { TargetKind } from "@prisma/client";

export interface CaseForPrompt {
  title: string;
  precondition: string;
  setupNote?: string;
  steps: string[];
  expected: string;
  priority: string;
  type: string;
  featureName?: string | null;
}

export interface TargetForPrompt {
  name: string;
  kind: TargetKind;
  description: string;
  config: Record<string, unknown>;
  /** Expanded reference keys ({{name}} / {{name.field}}); values never shown. */
  credentialKeys: string[];
  /** Typed credentials with descriptions, so the model picks by meaning not by
   *  guessing at names. Preferred over credentialKeys when present. */
  credentials?: CredentialPromptInfo[];
  /** Rotatable secret references (change + sync) via rotate_credential. */
  rotatableKeys?: string[];
  screen?: { width: number; height: number };
}

/** One credential as the model should understand it. */
export interface CredentialPromptInfo {
  name: string;
  /** Human label for the type, e.g. 「帳號密碼」/「API key」. */
  typeLabel: string;
  description: string;
  /** The `{{...}}` references the agent writes (e.g. name.username / name.password). */
  refs: string[];
  /** The rotatable secret's reference, or null when rotation is off. */
  rotatableRef: string | null;
}

/** The rules that hold for every executor, plus how to finish a case. */
const COMMON_RULES = [
  "- 每次只回傳「一個」動作。動作執行後你會拿到結果，再決定下一步。",
  "- 每一次回覆都必須同時包含 `observation` 和 `intent`：`observation` 寫你剛剛看到什麼，`intent` 寫這一步想達成什麼。",
  "- 嚴格照著測試步驟走。步驟沒寫的事不要自己加，例如不要順手修資料或跑別的流程。",
  "- 過程中如果注意到「和這條 case 無關」的問題（別的頁面壞掉、明顯的錯誤訊息、資料不一致），",
  "  用 `report_finding` 記下來，`params` 給 `{ severity, title, description }`，severity 是 critical / major / minor / info。",
  "  記完會自動回到原本的流程，不要因此偏離這條 case。",
  "- 收集到足夠證據判斷通過與否時，回傳 `done`，`params.summary` 簡述你觀察到的結果。",
  "- 卡住、做不到、或前置條件不成立時也回傳 `done`，在 summary 說明卡在哪裡。判定會另外做，你這裡不要下結論。",
  "- 如果你發現「整個被測系統根本連不上／沒啟動」——例如連線一直被拒、首頁完全打不開、整站都是連線層級錯誤或 5xx——",
  "  再測其他 case 也只是浪費，這時用 `abort_run` 動作，`params` 給 `{ reason }`（寫出你判斷系統掛掉的證據），會中止整趟執行。",
  "  務必謹慎：只有「整個系統性掛掉」才用。單一頁面 404、單一 API 500、某個功能壞掉都不算——那些用 `report_finding` 記下、或 `done` 結束這條就好。",
];

export interface McpToolForPrompt {
  serverId: string;
  server: string;
  name: string;
  description?: string;
}

export function caseSystemPrompt(target: TargetForPrompt, testCase: CaseForPrompt, mcpTools: McpToolForPrompt[] = []): string {
  const header = [
    "你是 QA Harness 的測試執行代理。你要照著一條測試案例實際操作被測目標，蒐集足以判斷通過與否的證據。",
    "",
    "## 被測目標",
    `${target.name}（種類：${target.kind}）`,
    target.description.trim() ? target.description.trim().slice(0, 6000) : "（沒有描述）",
  ];

  const caseBlock = [
    "",
    "## 這一條測試案例",
    `標題：${testCase.title}`,
    testCase.featureName ? `所屬功能：${testCase.featureName}` : "",
    `優先級：${testCase.priority}　類型：${testCase.type}`,
    `前置條件：${testCase.precondition || "（無）"}`,
    testCase.setupNote?.trim() ? `需要先準備的資料/狀態：${testCase.setupNote.trim()}（若這些前置在環境裡不存在、你也無法建立，就回傳 done 說明前置未滿足）` : "",
    "步驟：",
    ...testCase.steps.map((s, i) => `  ${i + 1}. ${s}`),
    `預期結果：${testCase.expected}`,
  ].filter(Boolean);

  const rules = ["", "## 規則", ...COMMON_RULES];
  const actions =
    target.kind === "api" ? apiActions(target) : desktopActions(target);
  const mcp = mcpToolsSection(mcpTools);

  return [...header, ...caseBlock, ...rules, "", ...actions, ...mcp, "", PHASES].join("\n");
}

function apiActions(target: TargetForPrompt): string[] {
  const lines = [
    "## 可用動作",
    "- `http_request`：`{ method, path, headers, query, body }`。",
    `  \`path\` 用相對路徑即可，會接在 base_url（${String(target.config.base_url ?? "未設定")}）後面。`,
    "  回應會原樣給你：status、headers、body。4xx / 5xx 不算執行失敗，那可能正是這條 case 要驗的。",
    "- `wait`：`{ ms }` 等待，例如非同步處理需要時間時。",
    "- `report_finding`、`done`：見上面的規則。",
  ];
  lines.push(...credentialsSection(target, "header 或 body"));
  return lines;
}

/**
 * Tell the model what each credential is, by meaning — so it stops guessing that
 * `login`/`password` (the admin account) is "the" login when a case wants a
 * regular user. Each credential shows its type, description and the exact
 * `{{...}}` references to write.
 */
function credentialsSection(target: TargetForPrompt, where: string): string[] {
  const creds = target.credentials;
  // Preferred path: typed credentials with descriptions.
  if (creds && creds.length) {
    const lines = [
      "",
      "## 憑證",
      `以下是可用的憑證。請依這條 case 指定的身份、以及每個憑證的說明，挑「對的那一個」，不要憑名字猜。要用時在${where}寫下對應的 \`{{…}}\`，系統會在送出前代入真值——你看不到、也不要自己編。`,
    ];
    for (const c of creds) {
      lines.push(`- 「${c.name}」（${c.typeLabel}）：${c.description.trim() || "（沒有說明）"}`);
      lines.push(`    用 ${c.refs.map((r) => `\`{{${r}}}\``).join("、")} 代入`);
    }
    // Any {{ref}} not backed by a typed credential is a value the setup flow
    // captured (login token, etc.) — still list it so it is usable.
    const typedRefs = new Set(creds.flatMap((c) => c.refs));
    const captured = target.credentialKeys.filter((k) => !typedRefs.has(k));
    if (captured.length) lines.push(`- 前置流程擷取的變數：${captured.map((k) => `\`{{${k}}}\``).join("、")}`);
    lines.push(...rotationSection(creds.filter((c) => c.rotatableRef).map((c) => ({ name: c.name, ref: c.rotatableRef! })), where));
    return lines;
  }
  // Fallback: a flat key list (older callers / tests without typed metadata).
  if (!target.credentialKeys.length) return [];
  const lines = [
    "",
    "## 憑證",
    `這個 Target 有這些憑證：${target.credentialKeys.join("、")}。`,
    `需要用到時，在${where}裡寫 \`{{憑證名稱}}\`，系統會在送出前代入真值。你看不到也不需要知道真正的值，不要自己編造。`,
  ];
  lines.push(...rotationSection((target.rotatableKeys ?? []).map((k) => ({ name: k, ref: k })), where));
  return lines;
}

/**
 * How to change a credential's value safely. Without this an agent testing a
 * password change would invent a literal password — leaking a live secret and
 * leaving the stored credential stale so the next login fails. Only shown for
 * credentials the owner marked rotatable.
 */
function rotationSection(rotatable: { name: string; ref: string }[], where: string): string[] {
  if (!rotatable.length) return [];
  return [
    "",
    "## 修改憑證（改密碼等）",
    `如果這條 case 要「修改某個憑證的值」，可輪替的有：${rotatable.map((r) => `\`${r.ref}\``).join("、")}。`,
    "不要自己編一個新值——先用 `rotate_credential` 動作，`params` 給 `{ credential: \"上面那個引用\" }`（例如 `member.password`）。",
    `系統會產生一組新值，並讓你用 \`{{該引用__next}}\` 代入到${where}（就像一般憑證那樣，你一樣看不到真值）。`,
    "改成功後，平台會自動把儲存的憑證同步成這個新值，之後的 case 與下一趟執行就會用新值登入。",
    "只有真的要改它的值時才用；只是「拿來登入」用原本的引用就好。",
  ];
}

function desktopActions(target: TargetForPrompt): string[] {
  const w = target.screen?.width ?? 1280;
  const h = target.screen?.height ?? 800;
  const url = String(target.config.url ?? "");
  const onHost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
  return [
    ...(onHost
      ? [
          "## 網址",
          `被測站台是 ${url}，它跑在主機上，不是這個容器裡。`,
          "在這個容器裡要用 `host.docker.internal` 這個主機名稱才連得到；`navigate` 動作會自動幫你換，",
          "但如果你用 `run_command` 下 curl 之類的指令，要自己寫成 host.docker.internal。",
          "",
        ]
      : []),
    "## 可用動作",
    "**優先用這組「看得到元素」的動作**——它們直接讀真實的網頁結構並操作元素，比在截圖上猜座標可靠得多：",
    "- `page_snapshot`：`{}` 讀出目前頁面的路徑、標題、可見連結、表單欄位（名稱／type／label）、按鈕與是否有彈窗。",
    "  **每次換頁或畫面有變化後，先用它看清楚有什麼**，再決定下一步，不要憑截圖猜。",
    "- `click_text`：`{ text, exact? }` 依「可見文字」點連結或按鈕（例如 `{ text: \"Sign In\" }`）。",
    "- `fill_field`：`{ field, value }` 依欄位名稱或 label 填值（例如 `{ field: \"password\", value: \"…\" }`）。",
    "- `press_key`：`{ key }` 送一個按鍵，例如 `Enter`、`Escape`。",
    "- `set_viewport`：`{ width, height, mobile? }` 改變視窗尺寸——**要測 RWD／不同螢幕寬度就用這個**。",
    "- `navigate`：`{ url }` 直接開網址（會一併回傳新頁面的結構）。",
    "",
    "退路（只有上面做不到時才用）：",
    `- 螢幕是 ${w}x${h}，座標原點在左上角。\`click\` / \`double_click\` / \`right_click\`：\`{ x, y }\`；\`move\`：\`{ x, y }\`；\`type\`：\`{ text }\`；\`key\`：\`{ key }\`（xdotool 語法）；\`scroll\`：\`{ direction, amount, x, y }\`。`,
    "- `screenshot`：`{}` 重新截圖（用來確認畫面長相／留證據）。",
    "- `run_command`：`{ command }` 在容器內執行 shell 指令。",
    "- `wait`：`{ ms }`",
    "- `report_finding`、`done`：見上面的規則。",
    "",
    "**做法建議**：`page_snapshot` 看清楚 → `click_text` / `fill_field` 操作 → 再 `page_snapshot` 或 `screenshot` 確認結果符不符合預期。",
    "每一個步驟都要真的做到、也真的確認過再往下走；沒驗到就不要說做完了。",
    ...credentialsSection(target, "`fill_field` 的 `value`（或退路 `type` 的 `text`）"),
  ];
}

/** External MCP tools available this run, and how to call one. */
function mcpToolsSection(tools: McpToolForPrompt[]): string[] {
  if (!tools.length) return [];
  const lines = [
    "",
    "## 外部工具（MCP）",
    "除了上面的動作，你還可以呼叫下列外部工具。用 `mcp_call` 動作，`params` 給 `{ server_id, tool, arguments }`（arguments 是這個工具需要的參數物件）。",
    "呼叫後你會拿到工具的回傳內容，再決定下一步。只有在對這條 case 真的有幫助時才用，不要為了用而用。",
  ];
  for (const t of tools) {
    lines.push(`- server_id=${t.serverId}｜tool=\`${t.name}\`${t.description ? `：${t.description.slice(0, 200)}` : ""}`);
  }
  return lines;
}

const PHASES =
  "## phase 怎麼填\n`setup` 準備前置條件、`executing` 執行步驟、`verifying` 確認結果、`judging` 收尾。";

/** Asked once per case, after the agent stops, to produce the verdict. */
export function verdictSystemPrompt(testCase: CaseForPrompt): string {
  return [
    "你是 QA Harness 的判定者。剛才有一個代理照著測試案例操作了被測目標，現在由你根據完整過程做出判定。",
    "",
    "## 這一條測試案例",
    `標題：${testCase.title}`,
    `前置條件：${testCase.precondition || "（無）"}`,
    "步驟：",
    ...testCase.steps.map((s, i) => `  ${i + 1}. ${s}`),
    `預期結果：${testCase.expected}`,
    "",
    "## 判定規則",
    "- `pass`：實際觀察到的結果符合預期結果。只有證據足夠時才給 pass，看起來沒問題但沒真的驗證到就不算。",
    "- `fail`：實際結果和預期不符。這時 `repro_steps` 必填，寫出讓別人能重現的最短步驟。",
    "- `blocked`：因為環境、前置條件或步數用完而沒能執行完，無法判斷對錯。",
    "- `reasoning` 要具體指出你依據過程中的哪一步、看到什麼才這樣判定，不要只寫「符合預期」。",
    "- `evidence_refs` 填你依據的步驟編號，例如 `step-3`。",
    "- `possibly_changed`：失敗的原因是「頁面、元件或 endpoint 根本不存在、流程入口消失」這種",
    "  看起來像功能被改掉或移除，而不是行為錯誤時，設為 true。單純的行為錯誤要留 false。",
  ].join("\n");
}

/** The transcript the judge sees. */
export function verdictTranscript(
  steps: { seq: number; phase: string; intent: string; observation: string; action: unknown; result?: unknown }[],
  stopReason: string,
): string {
  const lines = ["# 執行過程", ""];
  for (const s of steps) {
    lines.push(`## step-${s.seq}（${s.phase}）`);
    lines.push(`意圖：${s.intent}`);
    lines.push(`觀察：${s.observation}`);
    lines.push(`動作：${JSON.stringify(s.action)}`);
    if (s.result !== undefined) lines.push(`結果：${JSON.stringify(s.result).slice(0, 2000)}`);
    lines.push("");
  }
  lines.push(`# 結束原因`, stopReason);
  return lines.join("\n").slice(0, 60_000);
}
