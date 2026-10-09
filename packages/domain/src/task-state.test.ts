import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./state-machine.js";
import { TASK_TRANSITIONS, transitionTask } from "./task-state.js";
import type { TaskStatus } from "./types.js";

describe("transitionTask", () => {
  it("permite toda transição declarada na tabela", () => {
    for (const [from, tos] of TASK_TRANSITIONS) {
      for (const to of tos) {
        expect(transitionTask(from, to)).toBe(to);
      }
    }
  });

  it.each<[TaskStatus, TaskStatus]>([
    ["pending", "completed"],
    ["completed", "running"],
    ["cancelled", "pending"],
    ["failed", "running"],
    ["ready", "needs_human"],
  ])("rejeita %s -> %s", (from, to) => {
    expect(() => transitionTask(from, to)).toThrow(InvalidTransitionError);
  });
});
