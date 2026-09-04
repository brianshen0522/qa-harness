export type Role = "viewer" | "editor" | "owner";
export type TargetKind = "api" | "web" | "desktop";
export type TargetStatus = "idle" | "running";
export type UserStatus = "active" | "disabled";
export type LlmProvider = "anthropic" | "openai" | "ollama";
export type LlmPurpose = "discuss" | "generate" | "execute";

export interface Providers {
  google: boolean;
  github: boolean;
  dev: boolean;
}

export interface UserPrincipal {
  kind: "user";
  id: string;
  email: string;
  name: string | null;
}

export interface AdminPrincipal {
  kind: "admin";
  id: string;
  email: string;
}

export interface UserBrief {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  _count: { members: number; projects: number };
}

export interface TeamMember {
  teamId: string;
  userId: string;
  user: UserBrief;
}

export interface ProjectListItem {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  descriptionVersion: number;
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  myRole: Role;
  _count: { targets: number; members: number };
}

export interface TargetBrief {
  id: string;
  name: string;
  kind: TargetKind;
  status: TargetStatus;
  updatedAt: string;
}

export interface ProjectDetail {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  descriptionVersion: number;
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  targets: TargetBrief[];
  _count: { members: number };
  myRole: Role;
}

export interface DescriptionVersion {
  id: string;
  version: number;
  content: string;
  source: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: Role;
  user: UserBrief;
}

export type TargetConfig = Record<string, unknown>;

export interface Target {
  id: string;
  projectId: string;
  name: string;
  kind: TargetKind;
  config: TargetConfig;
  description: string | null;
  descriptionVersion: number;
  status: TargetStatus;
  myRole: Role;
  _count?: { credentials: number; members: number };
}

export interface TargetDetail extends Target {
  project: { id: string; name: string };
  credentialKeys: string[];
}

export interface TargetMember {
  user: UserBrief;
  projectRole: Role;
  targetRole: Role | null;
  effectiveRole: Role;
}

// Admin
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  authProvider: string | null;
  status: UserStatus;
  createdAt: string;
  teams: { id: string; name: string }[];
  projects: { id: string; name: string; role: Role }[];
}

export interface LlmConfig {
  id: string;
  name: string;
  provider: LlmProvider;
  endpoint: string | null;
  model: string;
  purposes: LlmPurpose[];
  supportsVision: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  chainPositions: Partial<Record<LlmPurpose, number>>;
}

export interface LlmConfigInput {
  name: string;
  provider: LlmProvider;
  endpoint?: string;
  apiKey?: string;
  model: string;
  purposes: LlmPurpose[];
  supportsVision: boolean;
  enabled?: boolean;
}

export type LlmTestResult =
  | {
      ok: true;
      text: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
    }
  | { ok: false; errorKind: string; error: string; status?: number; latencyMs: number };

export interface ChainEntry {
  purpose: LlmPurpose;
  llmConfigId: string;
  order: number;
  llmConfig: {
    id: string;
    name: string;
    model: string;
    provider: LlmProvider;
    enabled: boolean;
    supportsVision: boolean;
  };
}

export type Chains = Record<LlmPurpose, ChainEntry[]>;
export type Coverage = Record<LlmPurpose, number>;

export interface SandboxSettings {
  image: string;
  cpu: number;
  memoryMb: number;
  resolution: string;
  maxConcurrent: number;
  maxStepsPerCase: number;
  stepTimeoutSec: number;
  retentionDays: number;
}

export interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  target: string | null;
  payload: unknown;
  createdAt: string;
}

export interface Usage {
  byPurpose: {
    purpose: string;
    outcome: string;
    _count: { _all: number };
    _sum: { inputTokens: number | null; outputTokens: number | null };
  }[];
  recent: {
    id: string;
    purpose: string;
    schemaName: string | null;
    model: string | null;
    attempt: number;
    outcome: string;
    errorMessage: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    createdAt: string;
  }[];
}
