export { AgentRunnerImpl, PERSONAS } from "./agent-runner.js";
export type {
  AgentRunInput,
  AgentRunner,
  AgentRunResult,
  PersonaDefinition,
} from "./agent-runner.js";

export { classifyDeterministic, triageIntent } from "./intent-triage.js";
export type {
  Intent,
  IntentTriageOptions,
  IntentTriageResult,
  IntentTriageSource,
} from "./intent-triage.js";

export { buildFeatureGraph, DEFAULT_TASK_TIMEOUT_MS, FeatureGraphState } from "./feature-graph.js";
export type { FeatureGraph, FeatureGraphDeps, FeatureGraphInput } from "./feature-graph.js";

export { candidatesOf, findTarget } from "./harness-registry.js";
export type { ExecutionTargetEntry, TargetRegistry } from "./harness-registry.js";

export { AttemptControl, abortReasonOf } from "./attempt-control.js";
export type { AttemptAbortReason } from "./attempt-control.js";

export { buildHandover, renderHandoverForPrompt } from "./handover.js";
export type { TaskHandoverPayload } from "./handover.js";

export {
  changedPathsSince,
  ensureIntegrationWorktree,
  ensureTaskWorktree,
  hasNewCommits,
  integrationBranchName,
  integrationWorktreePath,
  mergeIntoIntegration,
  taskBranchName,
} from "./worktree.js";
export type { MergeResult } from "./worktree.js";

export { loadProjectConfig, prepareWorktree, verifyIntegration } from "./verify.js";
export type { VerifyResult } from "./verify.js";

export {
  FeaturePlanSchema,
  PlannedTaskSchema,
  WORKFLOW_TEMPLATES,
  planFeature,
  planWaves,
  singleTaskPlan,
  validatePlan,
} from "./plan.js";
export type { FeaturePlan, PlanFeatureResult, PlannedTask } from "./plan.js";

export { WORKER_CONTRACT, buildWorkerPrompt } from "./prompt-builder.js";
export type { WorkerPromptInput } from "./prompt-builder.js";

export { decideWorkspace } from "./workspace-policy.js";
export type { WorkspaceMode } from "./workspace-policy.js";

export { WorkerSlots } from "./worker-slots.js";

export { runTask } from "./task-runner.js";
export type { EngineDeps, FeatureContext, TaskRunOutcome } from "./task-runner.js";

export { appendTasks } from "./append-tasks.js";

export { checkFeatureOverlap, sharedPathsOf } from "./overlap.js";
export type { ActiveFeatureFootprint, FeatureOverlapResult, OverlapCheckInput } from "./overlap.js";

export { evaluateCompletion, isBlocking, SEVERITIES } from "./completion.js";
export type {
  CompletionInput,
  CompletionVerdict,
  RequirementCheck,
  ReviewFinding,
  Severity,
} from "./completion.js";

export { QUALITY_GATES, runQualityGates } from "./quality.js";
export type { GateResult, QualityGate } from "./quality.js";

export { GhPullRequestCreator, buildDeliverySummary } from "./delivery.js";
export type { PullRequestCreator, PullRequestInput } from "./delivery.js";

export { PLAN_CHANGE_REQUEST } from "./plan-changes.js";
export type { ApprovalDecision } from "./feature-graph.js";
