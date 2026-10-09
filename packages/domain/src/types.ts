// Tipos centrais do domínio APO.
//
// Mantém só o que já é usado (regra 3 do PLAN.md: não criar abstração sem uso
// real). Campos que só entram em fases futuras (role, expectedPaths, etc. —
// ver TECHNICAL_PLAN.md seção 5.1) chegam via migration quando a fase que os
// usa começar, não antes.

export type ProviderId = "anthropic" | "openai" | "google";
export type HarnessId = "claude-code" | "codex" | "gemini-cli" | "fake";

// --- Feature -----------------------------------------------------------

export type FeatureStatus =
  | "created"
  | "planning"
  | "executing"
  | "integrating"
  | "validating"
  | "reviewing"
  | "fixing"
  | "paused_capacity"
  | "awaiting_approval"
  | "delivering"
  | "rejected"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed"
  | "needs_human";

export type FeatureIntent = "bugfix" | "feature";

export interface Feature {
  id: string;
  projectId: string;
  objective: string;
  intent: FeatureIntent;
  status: FeatureStatus;
  integrationBranch?: string;
  fixIteration: number;
  prUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

// --- Task ----------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "retrying"
  | "awaiting_answer"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_human";

export type TaskKind = "read" | "write";

export interface Task {
  id: string;
  featureId: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  dependencies: string[];
  createdAt: Date;
  updatedAt: Date;
}

// --- TaskAttempt -----------------------------------------------------------

export type TaskAttemptStatus =
  | "starting"
  | "working"
  | "completed"
  | "failed"
  | "rate_limited"
  | "stalled"
  | "cancelled"
  | "interrupted";

export interface TaskAttempt {
  id: string;
  taskId: string;
  n: number;
  provider: ProviderId;
  harness: HarnessId;
  status: TaskAttemptStatus;
  startedAt: Date;
  endedAt?: Date;
}

// --- ExecutionPreference (seção 14.1 do PLAN.md) --------------------------

export type ExecutionMode = "auto" | "preferred" | "forced";

export interface ExecutionPreference {
  mode: ExecutionMode;
  provider?: ProviderId;
  harness?: HarnessId;
  model?: string;
}

export type ResolutionSource =
  | "task_override"
  | "feature_override"
  | "role_preference"
  | "jev"
  | "rule_router"
  | "global_default";

export interface ExecutionTarget {
  provider: ProviderId;
  harness: HarnessId;
  model: string;
  resolutionSource: ResolutionSource;
}

// --- Project ---------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  createdAt: Date;
}
