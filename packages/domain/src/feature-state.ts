import { createTransitionTable, transition } from "./state-machine.js";
import type { FeatureStatus } from "./types.js";

// Seção 5.2 do TECHNICAL_PLAN.md:
//
// created → planning → executing → integrating → validating → reviewing ─┐
//               ▲          │  ▲                                   │      │
//               │          │  └──────── fixing ◀── (gate/review falhou)  │
//               │          ▼                                            ▼
//           (replan)  paused_capacity                          awaiting_approval
//                                                                │        │
//                                                           delivering  rejected
//                                                                │
//                                                            completed
//
// De qualquer estado ativo: paused, cancelled, failed, needs_human.

const ESCAPE_HATCHES: readonly FeatureStatus[] = ["paused", "cancelled", "failed", "needs_human"];

const ACTIVE_STATES: readonly FeatureStatus[] = [
  "planning",
  "executing",
  "integrating",
  "validating",
  "reviewing",
  "fixing",
  "paused_capacity",
  "awaiting_approval",
  "delivering",
];

export const FEATURE_TRANSITIONS = createTransitionTable<FeatureStatus>([
  ["created", ["planning"]],
  ["planning", ["executing", "planning", ...ESCAPE_HATCHES]], // "planning" de novo = replan
  ["executing", ["integrating", "paused_capacity", ...ESCAPE_HATCHES]],
  ["paused_capacity", ["executing", ...ESCAPE_HATCHES]],
  ["integrating", ["validating", ...ESCAPE_HATCHES]],
  ["validating", ["reviewing", "fixing", ...ESCAPE_HATCHES]],
  ["reviewing", ["fixing", "awaiting_approval", ...ESCAPE_HATCHES]],
  ["fixing", ["executing", ...ESCAPE_HATCHES]],
  ["awaiting_approval", ["delivering", "rejected", ...ESCAPE_HATCHES]],
  ["rejected", ["fixing", ...ESCAPE_HATCHES]],
  ["delivering", ["completed", ...ESCAPE_HATCHES]],
  ["paused", [...ACTIVE_STATES]],
  ["needs_human", [...ACTIVE_STATES]],
  ["completed", []],
  ["cancelled", []],
  ["failed", []],
]);

export function transitionFeature(from: FeatureStatus, to: FeatureStatus): FeatureStatus {
  return transition(FEATURE_TRANSITIONS, "Feature", from, to);
}
