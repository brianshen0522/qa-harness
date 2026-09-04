import type { ChangeSource } from "@prisma/client";
import type { CaseSnapshot } from "./change-diff";

export interface FeatureForPrompt {
  id: string;
  name: string;
  description: string;
  status: string;
  caseCount: number;
}

export interface CaseForPrompt extends CaseSnapshot {
  id: string;
  featureId: string | null;
}

export interface ProposalContext {
  scope: "project" | "target";
  entityName: string;
  kind?: string;
  description: string;
  features: FeatureForPrompt[];
  cases: CaseForPrompt[];
  /** Present when the user edited the description and asked "分析影響". */
  proposedDescription?: string;
}

const SOURCE_LABEL: Record<ChangeSource, string> = {
  discussion: "討論區",
  handoff: "增量 Handoff 文件",
  manual: "手動編輯描述後要求分析影響",
  run_detection: "執行結果偵測（case 失敗的樣子像功能被改掉）",
  finding: "執行過程中記錄的 finding",
};

export const CHANGE_SYSTEM = [
  "你是 QA Harness 的變更分析員。使用者告訴你被測系統有了什麼變動，你要判斷這件事對現有的描述、功能清單、測試案例各有什麼影響，並產出一份「變更提案」。",
  "",
  "## 最重要的規則",
  "- 你只是「提案」。所有變動都要人逐項確認後才會生效，所以寧可把理由寫清楚，也不要自己省略。",
  "- 只動真的受影響的東西。沒被這次變更碰到的 feature 和 case 一律不要列進來，列了只會讓人多看一堆雜訊。",
  "- 每一項都要寫 `reason`，講清楚「為什麼這次的變更會影響到這一項」，不要只寫「已更新」。",
  "- 這一輪只做「影響判斷」，不要寫案例內容：`before` 和 `after` 一律留空，要改成什麼樣子之後會一條一條再問你。",
  "",
  "## 描述",
  "- `description_after`：把現有描述改寫成套用變更後的完整內容，整份給我，不要只給片段，也不要寫「其餘不變」。",
  "- `description_diff`：用條列講清楚描述改了哪些地方。",
  "- 如果這次變更完全沒有影響到描述，兩個欄位都給空字串。描述沒動就別重抄一遍，那只是浪費時間。",
  "",
  "## Feature 變動",
  "- `add`：新出現的功能。給 `name` 和 `description`，`feature_id` 給 null。",
  "- `modify`：既有功能的行為改了。`feature_id` 必須是下面清單裡的 id，`name` / `description` 給改完的樣子。",
  "- `remove`：功能被移除了。`feature_id` 必填。它底下的測試案例會一起標成 deprecated，所以不用再為它們各開一條 test case 變動。",
  "",
  "## Test case 變動",
  "- `add`：需要補的新案例。`feature_ref` 寫它屬於哪個功能的名稱（可以是這次新增的功能），",
  "  在 `reason` 裡一併寫清楚這條要驗什麼，內容之後會再問你。",
  "- `modify`：既有案例的步驟或預期結果要改。`case_id` 必須是下面清單裡的 id，`reason` 說明要往哪個方向改。",
  "- `mark_outdated`：這條案例可能受影響，但要怎麼改需要人來判斷。它會被標成待處理、預設不執行。",
  "- `deprecate`：對應的功能沒了，案例留著當歷史但不再執行。",
  "- 拿不準要不要改的，寧可用 `mark_outdated` 讓人來看，也不要硬改。",
].join("\n");

export function buildChangeContext(ctx: ProposalContext, source: ChangeSource, note: string): string {
  const lines: string[] = [
    `# 這次變更的來源\n${SOURCE_LABEL[source]}`,
    "",
    "# 使用者說明的變更內容",
    note.trim() || "（沒有文字說明，請只依據下面的資料判斷）",
    "",
    `# 目前的${ctx.scope === "project" ? "Project" : "Target"}`,
    `名稱：${ctx.entityName}${ctx.kind ? `（種類：${ctx.kind}）` : ""}`,
    "",
    "## 目前的描述",
    ctx.description.trim() || "（還沒有描述）",
  ];

  if (ctx.proposedDescription) {
    lines.push(
      "",
      "## 使用者已經改好的新描述",
      "使用者自己改了描述，內容如下。`description_after` 請直接用這一份，不要再自己改寫；",
      "你的工作是判斷這份新描述對 feature 和 test case 造成什麼影響。",
      "",
      ctx.proposedDescription.trim(),
    );
  }

  if (ctx.features.length) {
    lines.push("", "## 目前的功能清單");
    for (const f of ctx.features) {
      lines.push(
        `- id=${f.id}｜${f.name}｜${f.caseCount} 條案例${f.status === "removed" ? "｜已移除" : ""}`,
        f.description.trim() ? `  ${f.description.trim().slice(0, 400)}` : "",
      );
    }
  } else {
    lines.push("", "## 目前的功能清單", "（還沒有功能）");
  }

  if (ctx.cases.length) {
    // Titles only: a target can hold hundreds of cases, and the full text of all
    // of them is both slower than the gateway in front of the model allows and
    // more than this decision needs. The bodies come back per case afterwards.
    lines.push("", "## 目前的測試案例（只列標題，內容之後會單獨問）");
    for (const c of ctx.cases) {
      lines.push(
        `- id=${c.id}｜${c.featureName ?? "未歸類"}｜${c.priority}/${c.type}${c.status && c.status !== "active" ? `｜${c.status}` : ""}｜${c.title}`,
      );
    }
  } else {
    lines.push("", "## 目前的測試案例", "（還沒有測試案例）");
  }

  return lines.join("\n").slice(0, 120_000);
}

/** What a run's failures looked like, when the proposal comes from detection (§4.4 被動偵測). */
export function detectionNote(
  rows: { title: string; reasoning: string; featureName: string | null }[],
): string {
  const lines = [
    "以下測試案例在最近一次執行失敗了，而且失敗的樣子像是「功能被改掉或移除」，不像是單純的行為錯誤：",
    "",
  ];
  for (const r of rows) {
    lines.push(`- ${r.title}${r.featureName ? `（功能：${r.featureName}）` : ""}`);
    if (r.reasoning.trim()) lines.push(`  判定理由：${r.reasoning.trim().slice(0, 600)}`);
  }
  lines.push("", "請判斷這是不是功能真的變了，如果是，提出對應的變更提案。");
  return lines.join("\n");
}

/** A finding is an observation, not a verdict; say so, so the model does not over-reach. */
export function findingNote(f: { severity: string; title: string; description: string }): string {
  return [
    "執行過程中代理注意到一個和當時那條案例無關的問題，內容如下：",
    "",
    `嚴重程度：${f.severity}`,
    `標題：${f.title}`,
    f.description.trim() ? `說明：${f.description.trim().slice(0, 2000)}` : "",
    "",
    "請判斷這是不是代表被測系統的功能有變動。如果只是一個 bug 而不是功能變更，",
    "feature_changes 和 test_case_changes 可以只補上該補的測試案例，不要硬改描述。",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- second pass: one case at a time ----------

/**
 * The impact pass says *which* cases change; this asks what they should say.
 * Splitting it keeps every request small — a single call carrying a whole test
 * list and every rewritten case does not fit inside the gateway's timeout.
 */
export const CASE_DETAIL_SYSTEM = [
  "你是 QA Harness 的測試案例撰寫者。剛才已經判斷出某條案例因為這次的變更需要調整，現在請你把它寫出來。",
  "",
  "- 只回傳「一條」案例，放在 `cases` 陣列裡。",
  "- `steps` 是可以照著做的具體操作，一步一行；`expected` 要能明確判斷通過與否。",
  "- 沿用原本的 `feature_ref`，除非變更本身就是把它搬到別的功能底下。",
  "- 修改既有案例時，沒有被這次變更影響到的部分就照原樣保留，不要順手重寫。",
].join("\n");

export function caseDetailContext(input: {
  entityName: string;
  description: string;
  note: string;
  featureRef: string;
  reason: string;
  before?: CaseSnapshot | null;
}): string {
  const lines = [
    `# 被測目標\n${input.entityName}`,
    "",
    "## 描述（套用這次變更後）",
    input.description.trim().slice(0, 20_000) || "（沒有描述）",
    "",
    "## 這次的變更",
    input.note.trim().slice(0, 4000),
    "",
    `## 要寫的案例屬於功能：${input.featureRef || "（未歸類）"}`,
    `為什麼要動它：${input.reason || "（沒有說明）"}`,
  ];
  if (input.before) {
    lines.push(
      "",
      "## 這條案例目前的內容",
      `標題：${input.before.title}`,
      `前置條件：${input.before.precondition || "（無）"}`,
      "步驟：",
      ...input.before.steps.map((s, i) => `  ${i + 1}. ${s}`),
      `預期結果：${input.before.expected}`,
      `優先級：${input.before.priority}　類型：${input.before.type}`,
      "",
      "請給修改後的完整內容。",
    );
  } else {
    lines.push("", "這是一條全新的案例，請直接寫出來。");
  }
  return lines.join("\n");
}
