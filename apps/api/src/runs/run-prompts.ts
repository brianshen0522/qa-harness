import type { TargetKind } from "@prisma/client";

export interface CaseForPrompt {
  title: string;
  precondition: string;
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
  /** Names only; values are substituted server-side and never shown. */
  credentialKeys: string[];
  screen?: { width: number; height: number };
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
  if (target.credentialKeys.length) {
    lines.push(
      "",
      "## 憑證",
      `這個 Target 有這些憑證：${target.credentialKeys.join("、")}。`,
      "需要用到時，在 header 或 body 裡寫 `{{憑證名稱}}`，系統會在送出前代入真值。",
      "你看不到也不需要知道真正的值，不要自己編造。",
    );
  }
  return lines;
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
    `- 螢幕是 ${w}x${h}，座標原點在左上角。點擊前先確認元素在截圖上的實際位置，不要用猜的。`,
    "- `screenshot`：重新截圖。",
    "- `click` / `double_click` / `right_click`：`{ x, y }`",
    "- `move`：`{ x, y }`　- `type`：`{ text }`　- `key`：`{ key }`（xdotool 語法，如 `Return`、`ctrl+l`）",
    "- `scroll`：`{ direction, amount, x, y }`",
    "- `navigate`：`{ url }` 直接開網址，比手動點網址列可靠。",
    "- `run_command`：`{ command }` 在容器內執行 shell 指令。",
    "- `wait`：`{ ms }`",
    "- `report_finding`、`done`：見上面的規則。",
    ...(target.credentialKeys.length
      ? [
          "",
          "## 憑證",
          `需要登入時可用的憑證欄位：${target.credentialKeys.join("、")}。`,
          "在 `type` 的 `text` 裡寫 `{{憑證名稱}}`，系統會在輸入前代入真值。不要自己編造帳密。",
        ]
      : []),
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
