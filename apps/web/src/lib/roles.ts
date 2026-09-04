import type {
  AgentPhase,
  CaseStatus,
  CaseSource,
  CaseType,
  Completeness,
  GenerationMode,
  GenerationStatus,
  HandoffApplyMode,
  LlmHealth,
  LlmPauseReason,
  LlmPurpose,
  FindingStatus,
  Priority,
  QueueStatus,
  RunStatus,
  Severity,
  ProposalStatus,
  Role,
  TargetKind,
  TargetStatus,
  Verdict,
} from "../api/types";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasRole(myRole: Role | undefined, required: Role): boolean {
  if (!myRole) return false;
  return RANK[myRole] >= RANK[required];
}

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "檢視者",
  editor: "編輯者",
  owner: "擁有者",
};

export const ROLES: Role[] = ["viewer", "editor", "owner"];

export const KIND_LABEL: Record<TargetKind, string> = {
  api: "API",
  web: "Web",
  desktop: "Desktop",
};

export const STATUS_LABEL: Record<TargetStatus, string> = {
  idle: "閒置",
  running: "執行中",
};

export const PURPOSE_LABEL: Record<LlmPurpose, string> = {
  discuss: "討論（discuss）",
  generate: "生成（generate）",
  execute: "執行（execute）",
};

export const PURPOSES: LlmPurpose[] = ["discuss", "generate", "execute"];

/** Short form, for chips and table cells where the English name would not fit. */
export const PURPOSE_SHORT_LABEL: Record<LlmPurpose, string> = {
  discuss: "討論",
  generate: "生成",
  execute: "執行",
};

export const LLM_HEALTH_LABEL: Record<LlmHealth, string> = {
  healthy: "正常",
  degraded: "不穩",
  down: "失效",
};

export const LLM_HEALTH_TONE: Record<LlmHealth, "green" | "amber" | "red"> = {
  healthy: "green",
  degraded: "amber",
  down: "red",
};

/** Why a round or a pipeline is waiting for a model. */
export const PAUSE_REASON_LABEL: Record<LlmPauseReason, string> = {
  not_configured: "此用途尚未設定任何 LLM",
  all_down: "此用途的 LLM 都被斷路器停用",
  all_failed: "此用途的 LLM 全部嘗試失敗",
};

/** The backend also stores free-form pause reasons on the run row. */
export function pauseReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "-";
  return PAUSE_REASON_LABEL[reason as LlmPauseReason] ?? reason;
}

/** 毫秒 -> 「約 30 秒」／「約 5 分鐘」，給重測間隔這種粗略的數字用。 */
export function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 60_000) return `約 ${Math.round(ms / 1000)} 秒`;
  return `約 ${Math.round(ms / 60_000)} 分鐘`;
}

export const CONFIG_FIELDS: Record<TargetKind, { key: string; label: string; json?: boolean; placeholder?: string }[]> = {
  api: [
    { key: "base_url", label: "Base URL", placeholder: "https://api.example.com" },
    { key: "openapi_url", label: "OpenAPI URL", placeholder: "https://api.example.com/openapi.json" },
    { key: "headers", label: "Headers（JSON）", json: true, placeholder: '{"Authorization": "Bearer ..."}' },
  ],
  web: [
    { key: "url", label: "URL", placeholder: "https://example.com" },
    { key: "viewport", label: "Viewport", placeholder: "1280x800" },
  ],
  desktop: [
    { key: "image", label: "Image", placeholder: "ghcr.io/org/app:latest" },
    { key: "install_command", label: "安裝指令" },
    { key: "launch_command", label: "啟動指令" },
  ],
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-TW", { hour12: false });
}

export const COMPLETENESS_LABEL: Record<Completeness, string> = {
  unknown: "未知",
  partial: "部分",
  clear: "清楚",
};

export const COMPLETENESS_TONE: Record<Completeness, "gray" | "amber" | "green"> = {
  unknown: "gray",
  partial: "amber",
  clear: "green",
};

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: "待決定",
  accepted: "已接受",
  rejected: "已拒絕",
};

export const APPLY_MODE_LABEL: Record<HandoffApplyMode, string> = {
  overwrite: "覆蓋描述",
  merge: "合併進現有描述",
  attachment: "當作附件",
};

export const APPLY_MODES: HandoffApplyMode[] = ["overwrite", "merge", "attachment"];

/** Canonical handoff section key / title -> 中文 label（對應 spec §4.2 表格）。 */
const HANDOFF_SECTION_LABEL: Record<string, string> = {
  product_goal: "產品目標",
  modules: "模組清單",
  user_roles: "使用者角色",
  main_flows: "主要流程",
  tech_stack: "技術棧",
  dev_environment: "dev 環境",
  known_gaps: "已知未完成項目",
  endpoints: "Endpoint 清單",
  auth: "認證方式",
  test_accounts: "測試帳號",
  data_dependencies: "資料相依順序",
  routes: "路由表",
  page_components: "頁面元件與操作",
  forms: "表單與驗證規則",
  login_flow: "登入流程",
  selectors: "關鍵 selector",
  launch: "啟動方式",
  window_structure: "視窗結構",
  suggested_test_cases: "建議 test case",
  "Product Goal": "產品目標",
  Modules: "模組清單",
  "User Roles": "使用者角色",
  "Main Flows": "主要流程",
  "Tech Stack": "技術棧",
  "Dev Environment": "dev 環境",
  "Known Gaps": "已知未完成項目",
  Endpoints: "Endpoint 清單",
  Authentication: "認證方式",
  "Test Accounts": "測試帳號",
  "Data Dependencies": "資料相依順序",
  Routes: "路由表",
  "Page Components": "頁面元件與操作",
  "Forms And Validation": "表單與驗證規則",
  "Login Flow": "登入流程",
  Selectors: "關鍵 selector",
  Launch: "啟動方式",
  "Window Structure": "視窗結構",
  "Suggested Test Cases": "建議 test case",
};

/** Falls back to the raw key/title so unknown sections still render something. */
export function handoffSectionLabel(keyOrTitle: string): string {
  return HANDOFF_SECTION_LABEL[keyOrTitle] ?? keyOrTitle;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 測試清單（spec §4.3） ----------

export const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

export const CASE_TYPES: CaseType[] = ["happy", "edge", "negative"];

export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  happy: "正常流程",
  edge: "邊界",
  negative: "異常",
};

export const CASE_TYPE_TONE: Record<CaseType, "green" | "amber" | "purple"> = {
  happy: "green",
  edge: "amber",
  negative: "purple",
};

export const CASE_STATUSES: CaseStatus[] = ["active", "outdated", "deprecated"];

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  active: "正常",
  outdated: "待處理",
  deprecated: "已淘汰",
};

export const CASE_STATUS_TONE: Record<CaseStatus, "green" | "amber" | "gray"> = {
  active: "green",
  outdated: "amber",
  deprecated: "gray",
};

export const CASE_SOURCE_LABEL: Record<CaseSource, string> = {
  generated: "LLM 生成",
  manual: "手動撰寫",
  change_proposal: "變更提案",
};

export const GENERATION_MODES: GenerationMode[] = ["replace", "append"];

export const GENERATION_MODE_LABEL: Record<GenerationMode, string> = {
  replace: "重新生成",
  append: "附加",
};

export const GENERATION_STATUS_LABEL: Record<GenerationStatus, string> = {
  running: "執行中",
  paused: "等待 LLM",
  succeeded: "成功",
  failed: "失敗",
};

export const GENERATION_STATUS_TONE: Record<GenerationStatus, "amber" | "green" | "red"> = {
  running: "amber",
  paused: "amber",
  succeeded: "green",
  failed: "red",
};

/** 毫秒 -> 「1 分 12 秒」／「8.4 秒」。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

// ---------- 執行與結果（spec §4.5–4.7） ----------

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "排隊中",
  running: "執行中",
  paused: "等待 LLM",
  succeeded: "已完成",
  failed: "失敗",
  aborted: "已中止",
};

export const RUN_STATUS_TONE: Record<RunStatus, "gray" | "blue" | "amber" | "green" | "red"> = {
  queued: "gray",
  running: "blue",
  paused: "amber",
  succeeded: "green",
  failed: "red",
  aborted: "gray",
};

/** A run in one of these states still has (or is about to have) a live stream. */
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "running", "paused"];

export const VERDICTS: Verdict[] = ["pass", "fail", "blocked", "skipped"];

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "通過",
  fail: "失敗",
  blocked: "受阻",
  skipped: "略過",
};

export const VERDICT_TONE: Record<Verdict, "green" | "red" | "amber" | "gray"> = {
  pass: "green",
  fail: "red",
  blocked: "amber",
  skipped: "gray",
};

export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  queued: "等待中",
  running: "執行中",
  done: "已完成",
  skipped: "已跳過",
};

export const QUEUE_STATUS_TONE: Record<QueueStatus, "gray" | "blue" | "green"> = {
  queued: "gray",
  running: "blue",
  done: "green",
  skipped: "gray",
};

/** 執行代理每一步所處的階段（§4.6 三層進度的第二層）。 */
export const PHASES: AgentPhase[] = ["setup", "executing", "verifying", "judging"];

export const PHASE_LABEL: Record<AgentPhase, string> = {
  setup: "準備",
  executing: "執行",
  verifying: "驗證",
  judging: "判定",
};

export const PHASE_TONE: Record<AgentPhase, "blue" | "purple" | "amber" | "green"> = {
  setup: "blue",
  executing: "purple",
  verifying: "amber",
  judging: "green",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "嚴重",
  major: "重大",
  minor: "輕微",
  info: "提示",
};

export const SEVERITY_TONE: Record<Severity, "red" | "amber" | "blue" | "gray"> = {
  critical: "red",
  major: "amber",
  minor: "blue",
  info: "gray",
};

export const FINDING_STATUSES: FindingStatus[] = ["open", "converted_to_case", "converted_to_proposal", "dismissed"];

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: "待處理",
  converted_to_case: "已轉為測試案例",
  converted_to_proposal: "已轉為變更提案",
  dismissed: "已忽略",
};

export const FINDING_STATUS_TONE: Record<FindingStatus, "amber" | "blue" | "purple" | "gray"> = {
  open: "amber",
  converted_to_case: "blue",
  converted_to_proposal: "purple",
  dismissed: "gray",
};

/** 動作參數壓成一行，長字串截短，給 step 卡片用。 */
export function formatActionParams(params: Record<string, unknown> | undefined): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return "（無參數）";
  return entries
    .map(([k, v]) => {
      const text =
        v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
    })
    .join("  ");
}
