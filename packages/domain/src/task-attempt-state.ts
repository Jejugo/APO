import { createTransitionTable, transition } from "./state-machine.js";
import type { TaskAttemptStatus } from "./types.js";

// Seção 13 do PLAN.md + "interrupted" (restart do daemon, TECHNICAL_PLAN.md §3.1).

export const TASK_ATTEMPT_TRANSITIONS = createTransitionTable<TaskAttemptStatus>([
  ["starting", ["working", "failed"]],
  ["working", ["completed", "failed", "rate_limited", "stalled", "cancelled", "interrupted"]],
  ["stalled", ["cancelled", "interrupted"]],
  ["completed", []],
  ["failed", []],
  ["rate_limited", []],
  ["cancelled", []],
  ["interrupted", []],
]);

export function transitionTaskAttempt(
  from: TaskAttemptStatus,
  to: TaskAttemptStatus,
): TaskAttemptStatus {
  return transition(TASK_ATTEMPT_TRANSITIONS, "TaskAttempt", from, to);
}
