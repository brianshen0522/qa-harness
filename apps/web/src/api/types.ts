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
  isAdmin: boolean;
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

export type CredentialType = "password" | "api_key" | "bearer_token" | "cookie" | "other";

export interface TargetCredentialInfo {
  name: string;
  type: CredentialType;
  description: string;
  allowRotation: boolean;
  /** Which fields are set (["username","password"] or ["value"]). */
  fields: string[];
  /** The {{...}} references this credential exposes. */
  refs: string[];
  /** The rotatable secret's reference, or null when rotation is off. */
  rotatableRef: string | null;
}

export interface TargetDetail extends Target {
  project: { id: string; name: string };
  credentialKeys: string[];
  credentials: TargetCredentialInfo[];
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

// ---------- LLM 健康狀態與斷路器 ----------

/** `degraded` is still in the rotation; `down` has been taken out by the breaker. */
export type LlmHealth = "healthy" | "degraded" | "down";

/** Why a long-running job had to stop and wait for a model. */
export type LlmPauseReason = "not_configured" | "all_down" | "all_failed";

export interface LlmConfigHealth {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string;
  enabled: boolean;
  purposes: LlmPurpose[];
  health: LlmHealth;
  consecutiveFailures: number;
  downSince: string | null;
  lastFailureAt: string | null;
  /** e.g. "timeout" | "rate_limit" | "server" | "auth" | "network" */
  lastFailureKind: string | null;
  lastFailureMessage: string | null;
  lastProbeAt: string | null;
  nextProbeAt: string | null;
  probeAttempts: number;
  lastRecoveredAt: string | null;
}

/** Per purpose: how many enabled configs exist, and how many the breaker still trusts. */
export type HealthCoverage = Record<LlmPurpose, { configured: number; usable: number }>;

/** `GET /admin/llm/health` */
export interface LlmHealthStatus {
  configs: LlmConfigHealth[];
  coverage: HealthCoverage;
  /** How often the background prober retries a config the breaker took out. */
  probeIntervalMs: number;
}

export interface LlmProbeResult {
  ok: boolean;
  error?: string;
  latencyMs: number;
}

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
  apiConcurrency: number;
  stepTimeoutSec: number;
  retentionDays: number;
  recordVideo: boolean;
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
  models: { model: string | null; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  totalCostUsd: number;
  byProject: { projectId: string; name: string; runs: number; steps: number; costUsd: number }[];
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
  incremental?: boolean;
  hasPrevious?: boolean;
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

/** `paused` means the round is alive but waiting for an LLM to come back. */
export type SessionStatus = "idle" | "running" | "paused";

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
  /** No model was available; the round keeps its progress and waits. */
  | { type: "paused"; reason: LlmPauseReason; message: string }
  | { type: "resumed"; message: string }
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

// ---------- 測試清單與生成 pipeline（spec §4.3） ----------

export type Priority = "P0" | "P1" | "P2" | "P3";
export type CaseType = "happy" | "edge" | "negative";
export type CaseSource = "generated" | "manual" | "change_proposal";
export type CaseStatus = "active" | "outdated" | "deprecated";
export type FeatureStatus = "active" | "removed";
export type GenerationMode = "replace" | "append";
/** `paused` keeps its partial results and resumes by itself once a model returns. */
export type GenerationStatus = "running" | "paused" | "succeeded" | "failed";

export interface Feature {
  id: string;
  targetId: string;
  name: string;
  description: string;
  status: FeatureStatus;
  /** Description version this feature was derived from; older than the target's means stale. */
  basedOnDescriptionVersion: number;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestCase {
  id: string;
  targetId: string;
  featureId: string | null;
  title: string;
  precondition: string;
  setupNote?: string;
  steps: string[];
  expected: string;
  priority: Priority;
  type: CaseType;
  source: CaseSource;
  status: CaseStatus;
  currentVersion: number;
  order: number;
  basedOnDescriptionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureWithCases extends Feature {
  stale: boolean;
  cases: TestCase[];
}

export interface TestCaseCounts {
  features: number;
  cases: number;
  active: number;
  outdated: number;
  deprecated: number;
}

/** `GET /targets/:id/test-cases` — the whole list in one shot, grouped by feature. */
export interface TestCaseListData {
  target: {
    name: string;
    kind: TargetKind;
    status: TargetStatus;
    descriptionVersion: number;
    myRole: Role;
    locked: boolean;
  };
  counts: TestCaseCounts;
  features: FeatureWithCases[];
  /** Cases that belong to no feature — rendered as 未分類. */
  unassigned: TestCase[];
}

/** What a version row stores: the case as it looked at that version. */
export interface TestCaseSnapshot {
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: Priority;
  type: CaseType;
  featureId: string | null;
}

export interface TestCaseVersion {
  id: string;
  testCaseId: string;
  version: number;
  content: TestCaseSnapshot;
  changeId?: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface TestCaseInput {
  title: string;
  precondition?: string;
  setupNote?: string;
  steps: string[];
  expected: string;
  priority?: Priority;
  type?: CaseType;
  featureId?: string | null;
}

export interface GenerationRun {
  id: string;
  targetId: string;
  status: GenerationStatus;
  mode: GenerationMode;
  descriptionVersion: number;
  featureCount: number;
  caseCount: number;
  duplicatesDropped: number;
  /** 現況探索 summary, shape depends on the target kind. */
  discovery: unknown;
  model: string | null;
  error: string | null;
  /** Set while `status === "paused"`: why the pipeline is waiting. */
  pausedReason: string | null;
  pausedAt: string | null;
  triggeredById: string;
  startedAt: string;
  endedAt: string | null;
}

/** One `data:` payload of `POST /targets/:id/generate`. */
export type GenerationEvent =
  | { type: "started"; runId: string; target: string; kind: TargetKind; mode: GenerationMode; descriptionVersion: number }
  | { type: "discovery"; ok: boolean; source: string | null; note: string }
  | { type: "features"; features: { name: string; description: string }[]; model: string }
  | { type: "feature_started"; index: number; total: number; name: string }
  | { type: "feature_cases"; index: number; total: number; name: string; count: number; model: string }
  | { type: "deduped"; kept: number; dropped: number }
  | { type: "saved"; featureCount: number; caseCount: number }
  /** No model was available; progress is kept and the pipeline waits. */
  | { type: "paused"; reason: LlmPauseReason; message: string; featureIndex: number; total: number }
  | { type: "resumed"; message: string }
  | { type: "error"; message: string; detail?: unknown }
  | { type: "finished"; runId: string; featureCount: number; caseCount: number; durationMs: number };

export interface GenerationCancelResult {
  cancelled: boolean;
}

// ---------- 執行與結果（spec §4.5–4.7） ----------

/** `paused` keeps the run alive while it waits for a model to come back. */
export type RunStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "aborted" | "interrupted";
/** Where a case sits in this run's queue. */
export type QueueStatus = "queued" | "running" | "done" | "skipped";
export type Verdict = "pass" | "fail" | "blocked" | "skipped";
export type Severity = "critical" | "major" | "minor" | "info";
export type FindingStatus = "open" | "converted_to_case" | "converted_to_proposal" | "dismissed";

export type VerdictCounts = Record<Verdict, number>;

/** One request/response the executor made against an `api` target. */
export interface HttpLog {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  error?: string;
}

/** What a result carries as proof; keys are resolved through the evidence endpoint. */
export interface ResultEvidence {
  screenshots?: string[];
  /** Object key of the case's screen recording (§4.7 錄影); null for api runs. */
  video?: string | null;
  httpLogs?: HttpLog[];
  evidenceRefs?: string[];
}

export interface TestResultRow {
  id: string;
  verdict: Verdict;
  /** The failure looks like the feature changed rather than broke (§4.4). */
  possiblyChanged: boolean;
  llmReasoning: string;
  reproSteps: string[];
  stepCount: number;
  durationMs: number;
  evidence: ResultEvidence;
  /** Human review, kept beside the model's verdict rather than replacing it. */
  humanVerdict: Verdict | null;
  humanNote: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
}

/** `GET /targets/:id/runs` — newest first. */
export interface RunListItem {
  id: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
  sandboxName: string | null;
  viewUrl: string | null;
  pausedReason: string | null;
  error: string | null;
  triggeredById: string;
  verdicts: VerdictCounts;
  _count: { results: number; findings: number };
}

export interface RunFindingRow {
  id: string;
  testCaseId: string | null;
  severity: Severity;
  title: string;
  description: string;
  status: FindingStatus;
  /** What the finding turned into, when someone converted it (§4.7). */
  convertedCaseId: string | null;
  convertedProposalId: string | null;
  createdAt: string;
  feature: { id: string; name: string } | null;
}

/** A finding as shown in the target-level triage inbox. */
export interface InboxFinding extends RunFindingRow {
  run: { id: string; startedAt: string };
  caseTitle: string | null;
}

/** A regression case drafted from a finding, before anyone has saved it. */
export interface FindingCaseDraft {
  findingId: string;
  model: string;
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: Priority;
  type: CaseType;
  featureId: string | null;
  featureName: string | null;
}

/** One row of the run's queue, with the case as it was used and its result. */
export interface RunCase {
  caseId: string;
  order: number;
  queueStatus: QueueStatus;
  /** Null until the case starts; pinned from the case's version at that moment. */
  caseVersion: number | null;
  /** The case was edited after this run used it (§4.5). */
  editedAfterUse: boolean;
  testCase: {
    id: string;
    title: string;
    priority: Priority;
    type: CaseType;
    currentVersion: number;
    precondition: string;
    setupNote?: string;
    steps: string[];
    expected: string;
    feature: { id: string; name: string } | null;
  };
  result: TestResultRow | null;
}

export interface RunFeatureRate {
  id: string | null;
  name: string;
  pass: number;
  total: number;
}

/** `GET /runs/:runId` — everything the live page and the results page need. */
export interface RunDetail {
  run: {
    id: string;
    targetId: string;
    status: RunStatus;
    sandboxId: string | null;
    sandboxName: string | null;
    /** noVNC url for the shared live view; loopback only (§4.6). */
    viewUrl: string | null;
    stepCount: number;
    pausedReason: string | null;
    error: string | null;
    triggeredById: string;
    startedAt: string;
    endedAt: string | null;
    /** Which configs served the run, and where the chain fell over (§4.7). */
    llmUsage: RunLlmUsage | null;
    evidencePurgedAt: string | null;
    myRole: Role;
    target: { id: string; name: string; kind: TargetKind; projectId: string };
  };
  verdicts: VerdictCounts;
  cases: RunCase[];
  findings: RunFindingRow[];
  features: RunFeatureRate[];
}

export interface RunLlmUsage {
  configs: { configId: string; configName: string; models: string[]; calls: number; failures: number }[];
  switches: { at: string; fromConfigName: string; toConfigName: string; reason: string; caseId: string | null }[];
  /** Every time the whole chain was exhausted and the run had to wait. */
  outages: { at: string; reason: string; caseId: string | null }[];
}

/** `GET /runs/:runId/steps` — the persisted step rows, in sequence. */
export interface RunStepRow {
  id: string;
  seq: number;
  testCaseId: string | null;
  phase: AgentPhase;
  action: { type: string; params: Record<string, unknown> };
  intent: string;
  observation: string;
  screenshotKey: string | null;
  /** `detail` carries the executor's own payload, e.g. the HTTP status and body. */
  result: { ok: boolean; durationMs: number; error?: string; detail?: Record<string, unknown> } | null;
  modelUsed: string | null;
  durationMs: number;
  createdAt: string;
}

export interface StartRunResult {
  runId: string;
  total: number;
}

export interface AbortRunResult {
  aborted: boolean;
}

export interface SkipCaseResult {
  skipped: true;
}

export interface AddCaseResult {
  added: true;
  total: number;
}

/** One `data:` payload of `GET /targets/:id/runs/stream`; replayed in full on connect. */
export type RunEvent =
  | { type: "run_started"; runId: string; target: string; kind: TargetKind; total: number }
  | { type: "sandbox"; sandboxId: string | null; name: string | null; viewUrl: string | null; note: string }
  | { type: "setup_step"; seq: number; label: string; method: string; path: string; result: { ok: boolean; status: number | null; durationMs: number; error?: string }; captured: string[]; scope: "target" | "feature"; featureName?: string }
  | { type: "setup_done"; captured: string[]; stepCount: number; scope: "target" | "feature"; featureName?: string }
  | { type: "setup_failed"; message: string; scope: "target" | "feature"; featureName?: string }
  | { type: "case_started"; caseId: string; title: string; index: number; total: number; caseVersion: number }
  | {
      type: "step";
      caseId: string;
      seq: number;
      phase: AgentPhase;
      action: { type: string; params: Record<string, unknown> };
      intent: string;
      observation: string;
      result: { ok: boolean; durationMs: number; error?: string };
      model: string;
      screenshotKey: string | null;
    }
  | { type: "finding"; id: string; caseId: string | null; severity: Severity; title: string; description: string }
  | { type: "credential_rotated"; caseId: string; credential: string; committed: boolean; verified: boolean | null; note: string }
  | { type: "run_aborted_fatal"; caseId: string; reason: string }
  | {
      type: "case_finished";
      caseId: string;
      verdict: Verdict;
      reasoning: string;
      possiblyChanged: boolean;
      stepCount: number;
      durationMs: number;
    }
  | { type: "case_skipped"; caseId: string; title: string }
  | { type: "case_added"; caseId: string; title: string; total: number }
  /** No usable LLM; the run keeps its progress and resumes by itself. */
  | { type: "paused"; reason: string; message: string }
  | { type: "resumed"; message: string }
  | { type: "run_finished"; runId: string; status: RunStatus; counts: Record<string, number>; durationMs: number }
  | { type: "error"; message: string };

// ---------- change management (§4.4) ----------

export type ChangeSource = "discussion" | "handoff" | "manual" | "run_detection" | "finding";
export type ProposalState = "pending" | "applied" | "rejected";
export type FeatureOp = "add" | "modify" | "remove";
export type CaseOp = "add" | "modify" | "mark_outdated" | "deprecate";

export interface CaseSnapshot {
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: Priority;
  type: CaseType;
  featureName: string | null;
  status?: CaseStatus;
}

export interface FeatureChangeItem {
  id: string;
  op: FeatureOp;
  featureId: string | null;
  name: string;
  description: string;
  before: { name: string; description: string } | null;
  reason: string;
  /** Set when the model referred to something that is no longer there. */
  unresolved?: string;
}

export interface CaseChangeItem {
  id: string;
  op: CaseOp;
  caseId: string | null;
  featureRef: string;
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
  diff: string;
  reason: string;
  unresolved?: string;
}

export interface ChangeProposal {
  id: string;
  scope: Scope;
  projectId: string | null;
  targetId: string | null;
  source: ChangeSource;
  state: ProposalState;
  summary: string;
  descriptionDiff: string;
  descriptionAfter: string;
  hasDescriptionChange: boolean;
  featureChanges: FeatureChangeItem[];
  caseChanges: CaseChangeItem[];
  counts: { features: number; cases: number; unresolved: number };
  originNote: string | null;
  model: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ChangeProposalList {
  canEdit: boolean;
  running: boolean;
  proposals: ChangeProposal[];
}

export interface ChangeApplyResult {
  changeId: string;
  descriptionVersionAfter: number | null;
  affectedFeatureIds: string[];
  affectedTestCaseIds: string[];
  /** Only these features need their cases regenerating. */
  regenerableFeatureIds: string[];
}

export interface ChangeLogEntry {
  id: string;
  proposalId: string;
  source: ChangeSource;
  summary: string;
  descriptionVersionAfter: number | null;
  featureCount: number;
  caseCount: number;
  appliedAt: string;
  appliedBy: string;
}

export interface CaseHistoryEntry {
  version: number;
  content: Record<string, unknown>;
  createdAt: string;
  change: { id: string; summary: string; source: ChangeSource | null } | null;
}

// ---------- explore mode (§4.3 探索優先) ----------

export interface TargetIdentity {
  id: string;
  name: string;
  role: string;
  credentialKeys: string[];
  loginConfig: Record<string, unknown>;
  isAnonymous: boolean;
  order: number;
}

export interface IdentityList {
  identities: TargetIdentity[];
  credentialKeys: string[];
}

export type ExplorationStatus = "running" | "paused" | "succeeded" | "failed";

export interface ExploreStats {
  identities: number;
  routes: number;
  reachablePairs: number;
  rwdIssues: number;
  findings: number;
  suspiciousAccess: number;
  casesGenerated: number;
  coverage: { crawled: number; withForms: number; synthesized: number };
}

export interface ExploreRunRow {
  id: string;
  status: ExplorationStatus;
  stats: ExploreStats;
  llmCalls: number;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export type AccessState = "granted" | "denied" | "untested";

export interface PermissionRow {
  routeKey: string;
  title: string;
  access: Record<string, AccessState>;
}

export interface ExploreDetail {
  run: {
    id: string;
    status: ExplorationStatus;
    stats: ExploreStats;
    config: Record<string, unknown>;
    pausedReason: string | null;
    error: string | null;
    llmCalls: number;
    startedAt: string;
    endedAt: string | null;
    target: { id: string; name: string };
    myRole: Role;
  };
  identities: { id: string; name: string; role: string; isAnonymous: boolean; loginFailed?: boolean }[];
  nodes: {
    id: string;
    routeKey: string;
    sampleUrl: string;
    title: string;
    kind: string;
    depth: number;
    reachableBy: string[];
    deniedFor: string[];
    screenshotKey: string | null;
  }[];
  edges: { from: string; to: string | null; kind: string; label: string }[];
  matrix: { identities: string[]; rows: PermissionRow[]; suspicious: PermissionRow[] };
  observations: {
    id: string;
    nodeId: string | null;
    kind: "rwd_issue" | "finding" | "deep_note";
    severity: string | null;
    breakpoint: string | null;
    note: string;
    data: Record<string, unknown>;
    screenshotKey: string | null;
  }[];
}

/** Live SSE payload from POST /targets/:id/explore. */
export type ExploreEvent =
  | { type: "started"; runId: string; target: string; identities: string[] }
  | { type: "phase"; phase: "crawl" | "access" | "rwd" | "synthesis"; message: string }
  | { type: "login"; identity: string; ok: boolean; message: string }
  | { type: "visit"; identity: string; routeKey: string; depth: number; denied: boolean; nodes: number }
  | { type: "rwd"; routeKey: string; breakpoint: string; issues: number }
  | { type: "matrix"; routes: number; suspicious: number }
  | { type: "interact"; identity: string; routeKey: string; opener: string; found: string }
  | { type: "synth"; routeKey: string; cases: number }
  | { type: "paused"; reason: string; message: string }
  | { type: "resumed"; message: string }
  | { type: "error"; message: string }
  | { type: "finished"; runId: string; stats: ExploreStats; durationMs: number };

// ---------- API 前置流程 (§4.4) ----------
export interface SetupCapture {
  name: string;
  from: string;
}
export interface SetupRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}
export interface SetupStep {
  label: string;
  request: SetupRequest;
  captures: SetupCapture[];
}
export interface ApiSetup {
  steps: SetupStep[];
}

// ---------- Dashboard / run watcher ----------
export interface Verdicts { pass: number; fail: number; blocked: number; skipped: number }
export interface MyRun {
  id: string;
  targetId: string;
  targetName: string;
  projectId: string;
  status: "running" | "paused" | "queued" | "succeeded" | "failed" | "aborted" | "interrupted";
  total: number;
  done: number;
  verdicts: Verdicts;
  startedAt: string;
  endedAt: string | null;
}
export interface OverviewTarget {
  id: string;
  name: string;
  kind: TargetKind;
  projectId: string;
  projectName: string;
  running: boolean;
  outdatedCases: number;
  openFindings: number;
  activeRun: { id: string; status: string; total: number; done: number } | null;
  lastRun: { id: string; status: string; endedAt: string | null; verdicts: Verdicts } | null;
}
export interface Overview {
  targets: OverviewTarget[];
  totals: { activeRuns: number; failingTargets: number; outdatedCases: number; openFindings: number };
}
