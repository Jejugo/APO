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

export {
  buildFeatureGraph,
  DEFAULT_TASK_TIMEOUT_MS,
  FEATURE_GRAPH_RECURSION_LIMIT,
  FeatureGraphState,
} from "./feature-graph.js";
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
  syncBaseBranch,
  taskBranchName,
} from "./worktree.js";
export type { BaseSyncResult, MergeResult } from "./worktree.js";

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

export { DISTILLED_KINDS, distillMemories } from "./memory-writer.js";
export type { FeatureRetrospective, MemoryPort } from "./memory-writer.js";

export {
  LEAD_ACTIONS,
  LEAD_CHAT_INSTRUCTIONS,
  LeadActionSchema,
  decideLeadAction,
  summarizeConversation,
} from "./lead-chat.js";
export type { ChatContext, LeadAction } from "./lead-chat.js";
export { pickJudge, runnerFor } from "./judge.js";
export { replanFeature } from "./replan.js";
export type { ReplanInput, ReplanResult } from "./replan.js";

export {
  GLOBAL_QUESTION_MODE_KEY,
  LEAD_FIRST_MIN_CONFIDENCE,
  QUESTION,
  QUESTION_MODES,
  answerQuestion,
  effectiveQuestionMode,
  interpretHumanAnswer,
  pendingAnswerFor,
  questionLimits,
  resolveWithLead,
} from "./questions.js";
export type {
  QuestionMode,
  QuestionPayload,
  QuestionResolution,
  WorkerQuestion,
} from "./questions.js";
