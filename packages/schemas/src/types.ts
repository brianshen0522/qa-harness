// Hand-written TypeScript types mirroring /schemas/*.json (schema_version 1.0).

export type CompletenessStatus = "unknown" | "partial" | "clear";
export type TargetKind = "api" | "web" | "desktop";

export interface DiscussionTurn {
  schema_version: "1.0";
  message: string;
  questions: { item: string; question: string }[];
  draft_patch: { mode: "none" | "replace" | "append"; content: string };
  completeness: Record<string, CompletenessStatus>;
  target_proposals: {
    kind: TargetKind;
    name: string;
    config: Record<string, unknown>;
    credential_keys: string[];
    rationale: string;
  }[];
}

export interface FeatureList {
  schema_version: "1.0";
  features: { name: string; description: string }[];
}

export type Priority = "P0" | "P1" | "P2" | "P3";
export type CaseType = "happy" | "edge" | "negative";

export interface TestCaseOutput {
  schema_version: "1.0";
  cases: {
    feature_ref: string;
    title: string;
    precondition: string;
    steps: string[];
    expected: string;
    priority: Priority;
    type: CaseType;
  }[];
}

export interface ChangeProposal {
  schema_version: "1.0";
  summary: string;
  description_diff: string;
  feature_changes: {
    op: "add" | "modify" | "remove";
    feature_id?: string | null;
    name?: string;
    description?: string;
    reason: string;
  }[];
  test_case_changes: {
    op: "add" | "modify" | "mark_outdated" | "deprecate";
    case_id?: string | null;
    feature_ref?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason: string;
  }[];
}

export type ExecutionPhase = "setup" | "executing" | "verifying" | "judging";
export type ActionType =
  | "screenshot" | "click" | "double_click" | "right_click" | "type" | "key" | "scroll"
  | "move" | "wait" | "http_request" | "navigate" | "run_command" | "done";

export interface ExecutionStep {
  schema_version: "1.0";
  phase: ExecutionPhase;
  action: { type: ActionType; params: Record<string, unknown> };
  intent: string;
  observation: string;
}

export type Verdict = "pass" | "fail" | "blocked" | "skipped";

export interface CaseVerdict {
  schema_version: "1.0";
  verdict: Verdict;
  reasoning: string;
  evidence_refs: string[];
  repro_steps: string[];
  possibly_changed: boolean;
}

export type Severity = "critical" | "major" | "minor" | "info";

export interface Finding {
  schema_version: "1.0";
  severity: Severity;
  title: string;
  description: string;
  evidence_refs: string[];
  related_feature_ref: string | null;
}

export interface HandoffDocument {
  schema_version: "1.0";
  front_matter: {
    harness_version: string;
    scope: "project" | "target";
    target_kind?: TargetKind | null;
    generated_at: string;
    [k: string]: unknown;
  };
  sections: Record<string, string>;
  suggested_test_cases?: { feature?: string; title: string; steps?: string[]; expected?: string }[];
  detected_secrets?: string[];
}

export interface SchemaTypeMap {
  discussion_turn: DiscussionTurn;
  feature_list: FeatureList;
  test_case: TestCaseOutput;
  change_proposal: ChangeProposal;
  execution_step: ExecutionStep;
  case_verdict: CaseVerdict;
  finding: Finding;
  handoff_document: HandoffDocument;
}
