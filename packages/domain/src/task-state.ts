import { createTransitionTable, transition } from "./state-machine.js";
import type { TaskStatus } from "./types.js";

// Seção 5.2 do TECHNICAL_PLAN.md:
// pending → ready → running → completed
// running → retrying → running
// running → failed
// * → cancelled
// retrying → needs_human (preferência forced e target indisponível)
//
// awaiting_answer entra no M2 (pergunta bloqueante a um agente persistente,
// seção 6.9) — já modelado aqui porque é só dado, não comportamento novo.

export const TASK_TRANSITIONS = createTransitionTable<TaskStatus>([
  ["pending", ["ready", "cancelled"]],
  ["ready", ["running", "cancelled"]],
  ["running", ["completed", "retrying", "failed", "awaiting_answer", "cancelled"]],
  ["retrying", ["running", "needs_human", "cancelled"]],
  ["awaiting_answer", ["running", "needs_human", "cancelled"]],
  ["needs_human", ["running", "cancelled"]],
  ["completed", []],
  ["failed", ["cancelled"]],
  ["cancelled", []],
]);

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  return transition(TASK_TRANSITIONS, "Task", from, to);
}
