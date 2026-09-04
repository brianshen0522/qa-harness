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

// ---------- 討論區（spec §4.1） ----------

export type Scope = "project" | "target";
export type Completeness = "unknown" | "partial" | "clear";
export type CompletenessMap = Record<string, Completeness>;
export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface ChecklistItem {
  key: string;
  label: string;
  hint: string;
}

/** The structured payload an assistant turn carries (`discussion_turn` schema). */
export interface DiscussionTurn {
  schema_version: "1.0";
  message: string;
  questions: { item: string; question: string }[];
  draft_patch: { mode: "none" | "replace" | "append"; content: string };
  completeness: CompletenessMap;
  target_proposals: {
    kind: TargetKind;
    name: string;
    config: TargetConfig;
    credential_keys: string[];
    rationale: string;
  }[];
}

export interface LinkReference {
  url: string;
  title: string | null;
  chars: number;
  error: string | null;
}

export interface DiscussionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant messages only. */
  structured: DiscussionTurn | null;
  /** User messages only. */
  references: LinkReference[] | null;
  model: string | null;
  createdAt: string;
}

export interface TargetProposal {
  id: string;
  kind: TargetKind;
  name: string;
  config: TargetConfig;
  credentialKeys: string[];
  rationale: string;
  status: ProposalStatus;
  createdTargetId: string | null;
  createdAt: string;
}

export interface DiscussionState {
  id: string;
  scope: Scope;
  projectId: string;
  targetId: string | null;
  kind: TargetKind | null;
  entityName: string;
  checklist: ChecklistItem[];
  completeness: CompletenessMap;
  draft: string;
  messages: DiscussionMessage[];
  proposals: TargetProposal[];
  /** Target proposals only make sense in a Project discussion. */
  canPropose: boolean;
}

export interface DiscussionPostResult {
  userMessage: DiscussionMessage;
  assistantMessage: DiscussionMessage;
  turn: DiscussionTurn;
  draft: string;
  completeness: CompletenessMap;
  proposals: TargetProposal[];
  llm: { model: string; configName: string; fallbacks: number; attempts: number };
}

export type ProposalDecision = TargetProposal & { target?: Target };

export interface SavedDescription {
  id: string;
  description: string | null;
  descriptionVersion: number;
}

export interface ProjectAttachment {
  id: string;
  sourceType: "url" | "file" | "handoff";
  filename: string;
  mime: string;
  url: string | null;
  byteSize: number;
  createdAt: string;
}

// ---------- Context Handoff（spec §4.2） ----------

export type HandoffApplyMode = "overwrite" | "merge" | "attachment";

export interface HandoffPromptSection {
  title: string;
  ask: string;
}

export interface HandoffPrompt {
  scope: Scope;
  kind: TargetKind | null;
  harnessVersion: string;
  sections: HandoffPromptSection[];
  prompt: string;
}

export interface SuggestedTestCase {
  title: string;
  steps: string[];
  expected?: string;
}

export interface DetectedSecret {
  key: string;
  line: number;
  preview: string;
}

export interface HandoffParsed {
  frontMatter: Record<string, string>;
  /** Canonical section key -> markdown. */
  sections: Record<string, string>;
  /** Unrecognised title -> markdown. */
  unknownSections: Record<string, string>;
  suggestedTestCases: SuggestedTestCase[];
  detectedSecrets: DetectedSecret[];
  /** Canonical titles that are missing or still a placeholder. */
  missingSections: string[];
  unparsable: boolean;
  warnings: string[];
}

export interface HandoffPreview extends HandoffParsed {
  renderedDescription: string;
  currentDescription: string;
  recommendedMode: HandoffApplyMode;
}

export interface HandoffImportResult extends HandoffParsed {
  document: {
    id: string;
    importedAt: string;
    applyMode: HandoffApplyMode;
    appliedToDescriptionVersion: number | null;
  };
}

export interface HandoffDocumentListItem {
  id: string;
  scope: Scope;
  harnessVersion: string;
  applyMode: HandoffApplyMode;
  importedAt: string;
  importedById: string | null;
  appliedToDescriptionVersion: number | null;
}

// ---------- Sandbox 主控台（spec §4.5） ----------

export interface SandboxInstance {
  id: string;
  name: string;
  purpose: string;
  image: string;
  /** Docker container state: "running" | "exited" | "created" … */
  status: string;
  /** "healthy" | "starting" | "unhealthy" | "none" */
  health: string;
  running: boolean;
  createdAt: string;
  expiresAt: string | null;
  novncPort: number | null;
  agentPort: number | null;
  /** noVNC page for the live view; loopback only. */
  viewUrl: string | null;
  createdBy: string | null;
  /** e.g. "1280x800" */
  resolution: string | null;
}

export interface SandboxStatus {
  docker: { ok: boolean; version?: string; error?: string };
  image: { name: string; present: boolean };
  settings: SandboxSettings;
  running: number;
  maxConcurrent: number;
  instances: SandboxInstance[];
}

export interface SandboxScreenshot {
  ok: boolean;
  error: string | null;
  /** data: URL */
  image: string | null;
  width: number | null;
  height: number | null;
}

export interface SandboxActionResult {
  ok: boolean;
  action: string;
  durationMs: number;
  error?: string;
  detail: Record<string, unknown>;
  /** data: URL, screenshot only. */
  image?: string;
}

export type AgentPhase = "setup" | "executing" | "verifying" | "judging";

export type SessionStatus = "idle" | "running";

export interface SessionStepEvent {
  type: "step";
  /** Step number inside the current round. */
  step: number;
  phase: AgentPhase;
  intent: string;
  observation: string;
  action: { type: string; params: Record<string, unknown> };
  result: { ok: boolean; durationMs: number; error?: string; detail?: Record<string, unknown> };
  model: string;
  llmMs: number;
}

/**
 * One `data:` payload of the agent conversation stream. `seq` is the event's own
 * sequence number — unique and monotonic per session, so it doubles as the React
 * key and as the de-duplication key when the server replays past events.
 */
export type SessionEvent = { seq: number; at: string } & (
  | { type: "status"; status: SessionStatus }
  /** `interjected` marks a message that arrived while a round was already running. */
  | { type: "user_message"; content: string; interjected: boolean }
  | { type: "run_started"; runId: string; maxSteps: number; screen: string; sandbox: string }
  | { type: "thinking"; step: number }
  | SessionStepEvent
  | { type: "finished"; reason: "done" | "max_steps" | "aborted"; steps: number; summary: string }
  | { type: "error"; message: string; detail?: unknown }
  | { type: "reset" }
);

/** First render of the transcript, before the stream attaches. */
export interface SessionSnapshot {
  status: SessionStatus;
  events: SessionEvent[];
  turns: number;
  pending: number;
}

export interface SessionSendResult {
  queued: true;
  interjected: boolean;
  status: SessionStatus;
}
