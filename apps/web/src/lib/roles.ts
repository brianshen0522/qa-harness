import type { Completeness, HandoffApplyMode, LlmPurpose, ProposalStatus, Role, TargetKind, TargetStatus } from "../api/types";

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
