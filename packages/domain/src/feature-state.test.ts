import { describe, expect, it } from "vitest";
import { FEATURE_TRANSITIONS, transitionFeature } from "./feature-state.js";
import { InvalidTransitionError } from "./state-machine.js";
import type { FeatureStatus } from "./types.js";

describe("transitionFeature", () => {
  it("permite toda transição declarada na tabela", () => {
    for (const [from, tos] of FEATURE_TRANSITIONS) {
      for (const to of tos) {
        expect(transitionFeature(from, to)).toBe(to);
      }
    }
  });

  it.each<[FeatureStatus, FeatureStatus]>([
    ["created", "completed"],
    ["created", "executing"],
    ["completed", "planning"],
    ["awaiting_approval", "integrating"],
    ["executing", "rejected"],
    ["cancelled", "planning"],
    ["failed", "planning"],
  ])("rejeita %s -> %s", (from, to) => {
    expect(() => transitionFeature(from, to)).toThrow(InvalidTransitionError);
  });

  it("permite escape hatches de qualquer estado ativo", () => {
    const activeStates: FeatureStatus[] = [
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
    const escapeHatches: FeatureStatus[] = ["paused", "cancelled", "failed", "needs_human"];

    for (const from of activeStates) {
      for (const to of escapeHatches) {
        expect(transitionFeature(from, to)).toBe(to);
      }
    }
  });
});
