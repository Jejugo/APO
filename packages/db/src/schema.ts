import { bigserial, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Schema mínimo do M0 (seção 5.1 do TECHNICAL_PLAN.md) — só as colunas já
// usadas até o M1. Colunas de fases futuras (role, expected_paths,
// agent_messages, etc.) chegam via migration nova quando a fase que as usa
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
export const harnessEnum = pgEnum("harness", ["claude-code", "codex", "gemini-cli", "fake"]);

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

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const features = pgTable("features", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  objective: text("objective").notNull(),
  intent: featureIntentEnum("intent").notNull(),
  status: featureStatusEnum("status").notNull().default("created"),
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
  status: taskAttemptStatusEnum("status").notNull().default("starting"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
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
