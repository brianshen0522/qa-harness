import type { PermissionMatrix } from "./permission-matrix";

export interface NodeForSynthesis {
  routeKey: string;
  title: string;
  headings: string[];
  forms: { method: string; fields: { name: string | null; type: string; required: boolean; label: string | null }[] }[];
  controls: string[];
  reachableBy: string[];
  deniedFor: string[];
  rwdIssues: string[];
}

export const SYNTH_SYSTEM = [
  "你是 QA Harness 的測試設計者。系統已經被實際掃過一遍，你手上是「一個頁面實際長什麼樣」的結構化資料，不是猜的。",
  "根據這個頁面上真的存在的表單、欄位、控制項與可達性，設計測試案例。",
  "",
  "- 只針對這個頁面上「真的看得到」的東西出題，不要臆造不存在的欄位或按鈕。",
  "- 每個表單都要涵蓋 happy path 加上明顯的邊界／錯誤（必填留空、格式錯誤等）。",
  "- 有登入/權限差異時（某些身份可達、某些被擋），出一條驗證權限的案例。",
  "- 版面在某些尺寸下有問題時，出一條 RWD 案例，寫清楚在哪個寬度、預期不該發生什麼。",
  "- `feature_ref` 用這個頁面所屬的功能名稱（依 route 與標題判斷，例如「使用者管理」「登入」）。",
  "- 步驟要具體到別人照著做得出來；`expected` 要能明確判斷通過與否。",
  "- 除了單一頁面的欄位/按鈕驗證,也要設計「端到端功能流程」的案例:真實使用者為了完成一件事會跨頁操作 —— 例如用搜尋找到某個項目、點進詳情看內容、在列表與詳情之間往返、篩選後開啟結果、建立一筆資料後再回列表確認。",
  "- 依這個系統的「目的與各角色實際會做的事」去想他們真正的任務流程(某個角色登入後最常做什麼、一步步怎麼完成),不要只停在單頁的表單驗證。核心功能(例如搜尋、瀏覽內容、播放/檢視項目)一定要有涵蓋到端到端的案例。",
].join("\n");

export function synthesisContext(node: NodeForSynthesis, baseUrl: string): string {
  const lines = [
    `# 被測頁面\nroute：${node.routeKey}`,
    `完整網址範例：${baseUrl.replace(/\/$/, "")}${node.routeKey.split("?")[0]}`,
    node.title ? `標題：${node.title}` : "",
    node.headings.length ? `頁面標題階層：${node.headings.slice(0, 12).join(" / ")}` : "",
    "",
    "## 可達性",
    node.reachableBy.length ? `可進入的身份：${node.reachableBy.join("、")}` : "沒有任何身份能進入（可能是死路或需要特殊條件）",
    node.deniedFor.length ? `被擋下的身份：${node.deniedFor.join("、")}` : "",
  ];
  if (node.forms.length) {
    lines.push("", "## 表單");
    node.forms.forEach((f, i) => {
      lines.push(`表單 ${i + 1}（${f.method.toUpperCase()}）：`);
      for (const field of f.fields) {
        lines.push(`  - ${field.label ?? field.name ?? "(未命名)"}｜type=${field.type}${field.required ? "｜必填" : ""}`);
      }
    });
  }
  if (node.controls.length) lines.push("", `## 控制項\n${node.controls.slice(0, 20).join("、")}`);
  if (node.rwdIssues.length) lines.push("", `## 已偵測到的 RWD 問題\n${node.rwdIssues.join("\n")}`);
  return lines.filter(Boolean).join("\n").slice(0, 12_000);
}

/** A single synthesis call dedicated to cross-identity access, from the matrix. */
export function permissionContext(matrix: PermissionMatrix, baseUrl: string): string {
  const lines = [
    "# 權限矩陣（由實際掃描比對得出）",
    `被測站台：${baseUrl}`,
    "下面每一列是一個頁面，以及各身份能不能進入。請針對「應該被擋卻能進入」或「值得明確驗證權限邊界」的頁面出測試案例。",
    "越權存取（低權限身份能看到高權限頁面）是最該出題的類型。",
    "",
    `身份：${matrix.identities.join("、")}`,
    "",
  ];
  for (const row of matrix.rows) {
    const cells = matrix.identities.map((id) => {
      const state = row.access[id];
      return `${id}=${state === "granted" ? "可進" : state === "denied" ? "被擋" : "未測"}`;
    });
    lines.push(`- ${row.routeKey}：${cells.join("、")}`);
  }
  lines.push("", "`feature_ref` 一律用「權限控制」。");
  return lines.join("\n").slice(0, 12_000);
}

/** Stage E: a read-only deep look at one page. The model never mutates. */
export const DEEP_SYSTEM = [
  "你是 QA Harness 的探索員。給你一個頁面的截圖和它的結構（表單、欄位、控制項）。",
  "你的工作是「看」，不是「動」—— 絕對不要真的送出表單、刪除資料或觸發任何會改變狀態的操作，你只是在盤點。",
  "",
  "- `scenarios`：列出這個頁面值得測的情境。表單想到 happy path、必填留空、格式錯誤、超長輸入、邊界值；清單想到空/滿/分頁；有權限或狀態差異也算。每個寫 title 和為什麼（rationale）。",
  "- `findings`：當下截圖裡就看得出來的問題（版面破掉、錯誤訊息、明顯不一致、文字溢出）。沒有就給空陣列，不要硬湊。",
  "- 不要把「環境層級」的東西當成 finding：像是 dev/localhost 用 http 而非 https、缺少 HTTPS、開發用連線不安全這類——那是部署環境設定,不是被測系統的缺陷,一律略過。",
  "- 只根據畫面上和結構裡真的有的東西，不要臆造。",
  "- scenarios 不要只列單頁的欄位驗證:也要想這個頁面在整個功能流程裡扮演什麼 —— 若是列表/搜尋頁,想「搜尋或篩選後點開其中一項看詳情」;若是詳情頁,想「從列表進來、內容正確呈現、能返回」。把使用者真正要完成的任務走一遍。",
].join("\n");

export function deepContext(node: { routeKey: string; title: string; forms: unknown; controls: string[] }): string {
  return [
    `# 頁面\nroute：${node.routeKey}`,
    node.title ? `標題：${node.title}` : "",
    "",
    "## 結構",
    "表單：" + JSON.stringify(node.forms).slice(0, 3000),
    node.controls.length ? `控制項：${node.controls.slice(0, 20).join("、")}` : "",
    "",
    "截圖如附。請盤點情境與當下可見的問題。",
  ].filter(Boolean).join("\n");
}
