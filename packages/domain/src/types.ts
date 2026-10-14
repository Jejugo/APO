// Tipos centrais do domínio APO.
//
// Mantém só o que já é usado (regra 3 do PLAN.md: não criar abstração sem uso
// real). Campos que só entram em fases futuras (role, expectedPaths, etc. —
// ver TECHNICAL_PLAN.md seção 5.1) chegam via migration quando a fase que os
// usa começar, não antes.

export type ProviderId = "anthropic" | "openai" | "google";
export type HarnessId = "claude-code" | "codex" | "gemini-cli" | "antigravity" | "fake";

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

export type FeatureIntent = "bugfix" | "feature" | "document";

export interface Feature {
  id: string;
  projectId: string;
  objective: string;
  intent: FeatureIntent;
  status: FeatureStatus;
  // Escolhido na criação (flag --harness) — persistido aqui para a recovery
  // (M1.13) saber o que retomar mesmo se o daemon caiu antes de 'plan' criar
  // a Task.
  executionPreference?: ExecutionPreference;
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
  // Override manual via `--harness` (seção 14.1 do PLAN.md). A hierarquia
  // completa (Feature override → Role preference → router) chega no M2/M3.
  executionPreference?: ExecutionPreference;
  worktreePath?: string;
  branch?: string;
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
  model?: string;
  // Texto livre: o vocabulário canônico (FailureKind) vive em packages/harnesses.
  failureKind?: string;
  pid?: number;
  logPath?: string;
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
  | "global_default"
  /** M7: retomada da sessão do worker com a resposta à pergunta dele. */
  | "resume";

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
  // Snapshot do .apo/project.yaml no momento de `apo project add` — o
  // arquivo continua sendo a fonte de verdade; isto é auditoria/drift.
  configSnapshot?: Record<string, unknown>;
  createdAt: Date;
}

// --- ProjectAgent (seção 6.8 do TECHNICAL_PLAN.md) --------------------------
//
// "persistent" nunca significa processo aberto: dá continuidade de contexto
// (memoryNamespace a partir do M5, conversationThreadId a partir do M6), não
// uma sessão de CLI viva entre chamadas de AgentRunner.run().

export type ProjectAgentLifecycle = "persistent" | "dynamic";

export interface ProjectAgent {
  id: string;
  projectId: string;
  roleId: string;
  lifecycle: ProjectAgentLifecycle;
  executionPreference?: ExecutionPreference;
  memoryNamespace?: string;
  conversationThreadId?: string;
  enabled: boolean;
}
