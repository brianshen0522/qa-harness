import type { TargetKind } from "@prisma/client";

export interface ChecklistItem {
  key: string;
  label: string;
  hint: string;
}

/** Spec §4.1: what a Project discussion must clarify. */
export const PROJECT_CHECKLIST: ChecklistItem[] = [
  { key: "product_goal", label: "產品目標", hint: "這個產品要解決什麼問題、給誰用" },
  { key: "user_roles", label: "使用者角色", hint: "有哪些角色，各自能做什麼" },
  { key: "main_flows", label: "主要流程", hint: "使用者最常走的幾條路徑" },
  { key: "modules", label: "模組", hint: "系統拆成哪些功能模組" },
  { key: "tech_stack", label: "技術棧", hint: "前後端框架、資料庫、部署方式" },
  { key: "dev_environment", label: "dev 環境", hint: "測試環境網址、如何啟動、有無測試資料" },
  { key: "test_surfaces", label: "被測面", hint: "有哪些 API、前端頁面或 app 需要被測" },
];

/** Spec §4.2 table: what a Target discussion must clarify, per kind. */
export const TARGET_CHECKLISTS: Record<TargetKind, ChecklistItem[]> = {
  api: [
    { key: "endpoints", label: "Endpoint 清單", hint: "方法、路徑、參數、回應、錯誤碼" },
    { key: "auth", label: "認證方式", hint: "token / basic / oauth，如何取得" },
    { key: "test_accounts", label: "測試帳號", hint: "測試帳號從哪裡來、有哪些權限" },
    { key: "data_dependencies", label: "資料相依順序", hint: "哪些 API 必須先呼叫才有資料可測" },
  ],
  web: [
    { key: "routes", label: "路由表", hint: "有哪些頁面、各自網址" },
    { key: "page_components", label: "頁面元件與操作", hint: "每頁的主要元件與可執行的操作" },
    { key: "forms", label: "表單與驗證規則", hint: "欄位、必填、格式限制、錯誤訊息" },
    { key: "login_flow", label: "登入流程", hint: "如何登入、需要哪些憑證" },
    { key: "selectors", label: "關鍵 selector", hint: "data-testid 或穩定的 selector" },
  ],
  desktop: [
    { key: "launch", label: "啟動方式", hint: "安裝指令、image、啟動命令" },
    { key: "window_structure", label: "視窗結構", hint: "主視窗、對話框、選單" },
    { key: "main_flows", label: "主要操作路徑", hint: "使用者最常做的操作" },
  ],
};

export function checklistFor(scope: "project" | "target", kind?: TargetKind | null): ChecklistItem[] {
  if (scope === "project") return PROJECT_CHECKLIST;
  return TARGET_CHECKLISTS[kind ?? "web"];
}

export type CompletenessMap = Record<string, "unknown" | "partial" | "clear">;

/** Start every checklist item at "unknown". */
export function initialCompleteness(items: ChecklistItem[]): CompletenessMap {
  return Object.fromEntries(items.map((i) => [i.key, "unknown" as const]));
}

/**
 * Merge an LLM-reported completeness map into the stored one:
 * only known keys are accepted, unreported keys keep their previous value.
 */
export function mergeCompleteness(
  items: ChecklistItem[],
  current: CompletenessMap,
  incoming: CompletenessMap,
): CompletenessMap {
  const valid = new Set(items.map((i) => i.key));
  const out: CompletenessMap = { ...initialCompleteness(items), ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (valid.has(k) && ["unknown", "partial", "clear"].includes(v)) out[k] = v;
  }
  return out;
}
