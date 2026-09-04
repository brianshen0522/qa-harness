import type { Role, TargetKind, TargetStatus, LlmPurpose } from "../api/types";

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
