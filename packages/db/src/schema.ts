import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Schema do M0 + M1 (seção 5.1 do TECHNICAL_PLAN.md) — só as colunas já
// usadas até o M1. Colunas de fases futuras (expected_paths, agent_messages,
// handovers, etc.) chegam via migration nova quando a fase que as usa
// começar, não antes (regra 3 do PLAN.md).

export const featureIntentEnum = pgEnum("feature_intent", ["bugfix", "feature"]);

export const featureStatusEnum = pgEnum("feature_status", [
  "created",
  "planning",
  "executing",
  "integrating",
  "validating",
  "reviewing",
  "fixing",
  "paused_capacity",
  "awaiting_approval",
  "delivering",
  "rejected",
  "completed",
  "paused",
  "cancelled",
  "failed",
  "needs_human",
]);

export const taskKindEnum = pgEnum("task_kind", ["read", "write"]);

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "ready",
  "running",
  "retrying",
  "awaiting_answer",
  "completed",
  "failed",
  "cancelled",
  "needs_human",
]);

export const providerEnum = pgEnum("provider", ["anthropic", "openai", "google"]);
export const harnessEnum = pgEnum("harness", [
  "claude-code",
  "codex",
  "gemini-cli",
  "antigravity",
  "fake",
]);

export const taskAttemptStatusEnum = pgEnum("task_attempt_status", [
  "starting",
  "working",
  "completed",
  "failed",
  "rate_limited",
  "stalled",
  "cancelled",
  "interrupted",
]);

export const projectAgentLifecycleEnum = pgEnum("project_agent_lifecycle", [
  "persistent",
  "dynamic",
]);

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  // Snapshot do .apo/project.yaml lido em `apo project add` (M1.3) — não é a
  // fonte de verdade (o arquivo é), serve para auditoria e para detectar
  // drift entre o que o Project tinha quando foi registrado e o que tem hoje.
  configSnapshot: jsonb("config_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Seção 6.8 do TECHNICAL_PLAN.md — M1 só cria o registro "lead" por Project.
// "persistent" nunca significa processo aberto: dá continuidade de contexto
// (memoryNamespace/conversationThreadId, usados a partir do M5/M6), não uma
// sessão de CLI viva entre chamadas.
export const projectAgents = pgTable("project_agents", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  roleId: text("role_id").notNull(),
  lifecycle: projectAgentLifecycleEnum("lifecycle").notNull(),
  executionPreference: jsonb("execution_preference"),
  memoryNamespace: text("memory_namespace"),
  conversationThreadId: text("conversation_thread_id"),
  enabled: boolean("enabled").notNull().default(true),
});

export const features = pgTable("features", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  objective: text("objective").notNull(),
  intent: featureIntentEnum("intent").notNull(),
  status: featureStatusEnum("status").notNull().default("created"),
  // Escolhido na criação (flag --harness) e persistido aqui, não só na Task —
  // se o daemon cair antes do node 'plan' criar a Task, a recovery (M1.13)
  // ainda precisa saber qual harness retomar com.
  executionPreference: jsonb("execution_preference"),
  /** Plano (DAG) gerado antes da criação — o FeatureOverlapCheck precisa dos
   * expectedPaths antes de a Feature existir (M2.5/M2.12). */
  plan: jsonb("plan"),
  integrationBranch: text("integration_branch"),
  fixIteration: integer("fix_iteration").notNull().default(0),
  prUrl: text("pr_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  featureId: text("feature_id")
    .notNull()
    .references(() => features.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  kind: taskKindEnum("kind").notNull(),
  status: taskStatusEnum("status").notNull().default("pending"),
  dependencies: text("dependencies").array().notNull().default([]),
  /** Ordem estável dentro da Feature (t1, t2…) — usada no nome da branch. */
  seq: integer("seq").notNull().default(1),
  // Override da Task (seção 14.1 do PLAN.md): vence Feature override e Role preference.
  executionPreference: jsonb("execution_preference"),
  /** Id do RoleDefinition (M2.15). */
  role: text("role"),
  /** Estimativa do planner (M2.5) — base do FeatureOverlapCheck (M2.12). */
  expectedPaths: text("expected_paths").array(),
  /** O que de fato mudou (git diff), calculado pelo APO, não auto-relatado. */
  actualChangedPaths: text("actual_changed_paths").array(),
  /** `WorkerReport.artifacts` (M2.9), injetado nas Tasks dependentes. */
  artifacts: jsonb("artifacts"),
  /** Resumo do `WorkerReport`, também repassado às dependentes. */
  summary: text("summary"),
  /** plan | conflict | overlap_absorbed (seção 5.1). */
  origin: text("origin").notNull().default("plan"),
  /** isolated | shared | integration (M2.2). */
  workspaceMode: text("workspace_mode"),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskAttempts = pgTable("task_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  n: integer("n").notNull(),
  provider: providerEnum("provider").notNull(),
  harness: harnessEnum("harness").notNull(),
  // Texto livre, não enum: o vocabulário canônico (FailureKind) vive em
  // packages/harnesses (regra 4 do PLAN.md) — packages/db não deve depender
  // dele só para validar uma coluna.
  model: text("model"),
  /** Id do target do `config.yaml` (M3.2) — distingue dois targets com o mesmo harness. */
  targetId: text("target_id"),
  resolutionSource: text("resolution_source"),
  /** Handover recebido no início deste attempt (attempt 2+ após um failover). */
  handoverId: text("handover_id"),
  failureKind: text("failure_kind"),
  failureMessage: text("failure_message"),
  pid: integer("pid"),
  logPath: text("log_path"),
  status: taskAttemptStatusEnum("status").notNull().default("starting"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// M3 — capacidade por provider (seção 15 do PLAN.md). `usage_percent` só é
// preenchido quando existir fonte oficial; nunca inventado.
export const providerAvailabilityEnum = pgEnum("provider_availability", [
  "available",
  "degraded",
  "exhausted",
  "unknown",
]);

export const providerCapacity = pgTable("provider_capacity", {
  provider: providerEnum("provider").primaryKey(),
  availability: providerAvailabilityEnum("availability").notNull().default("unknown"),
  usagePercent: integer("usage_percent"),
  resetAt: timestamp("reset_at", { withTimezone: true }),
  reason: text("reason"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

// Toda escolha de target vira uma linha aqui (regra 7 do PLAN.md).
export const routingDecisions = pgTable("routing_decisions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  router: text("router").notNull(),
  resolutionSource: text("resolution_source").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  finalTarget: jsonb("final_target"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Seção 6.4 do TECHNICAL_PLAN.md — camada determinística no M3; a semântica
// (via AgentRunner) é opcional e fica para depois.
export const handovers = pgTable("handovers", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  fromAttemptId: text("from_attempt_id")
    .notNull()
    .references(() => taskAttempts.id),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  projectId: text("project_id"),
  featureId: text("feature_id"),
  taskId: text("task_id"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
