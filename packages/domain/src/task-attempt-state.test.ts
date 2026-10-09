import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./state-machine.js";
import { TASK_ATTEMPT_TRANSITIONS, transitionTaskAttempt } from "./task-attempt-state.js";
import type { TaskAttemptStatus } from "./types.js";

describe("transitionTaskAttempt", () => {
  it("permite toda transição declarada na tabela", () => {
    for (const [from, tos] of TASK_ATTEMPT_TRANSITIONS) {
      for (const to of tos) {
        expect(transitionTaskAttempt(from, to)).toBe(to);
      }
    }
  });

  it.each<[TaskAttemptStatus, TaskAttemptStatus]>([
    ["completed", "working"],
    ["failed", "completed"],
    ["starting", "stalled"],
    ["rate_limited", "working"],
  ])("rejeita %s -> %s", (from, to) => {
    expect(() => transitionTaskAttempt(from, to)).toThrow(InvalidTransitionError);
  });
});
