import { describe, expect, it } from "vitest";
import { executionCandidates, resolveForPlanning, resolveForPurpose } from "./purpose.js";
import type { ProviderCapacitySnapshot, RoutingCandidate } from "./types.js";

const opus: RoutingCandidate = {
  targetId: "opus",
  provider: "anthropic",
  harness: "claude-code",
  bestFor: ["planning"],
};
const sonnet: RoutingCandidate = {
  targetId: "sonnet",
  provider: "anthropic",
  harness: "claude-code",
  bestFor: ["complex"],
};
const sol: RoutingCandidate = {
  targetId: "sol",
  provider: "openai",
  harness: "codex",
  bestFor: ["planning", "complex"],
};

const snapshot = (
  provider: RoutingCandidate["provider"],
  availability: ProviderCapacitySnapshot["availability"],
): ProviderCapacitySnapshot => ({
  provider,
  availability,
  activeWorkers: 0,
  recentFailures: 0,
  capturedAt: new Date(0),
});
const free = (provider: RoutingCandidate["provider"]) => snapshot(provider, "available");

describe("resolveForPlanning", () => {
  it("escolhe entre os targets de planejamento, mesmo que outro venha primeiro no config", () => {
    const result = resolveForPlanning({ candidates: [sonnet, opus, sol], capacity: free });
    expect(result.kind).toBe("target");
    if (result.kind === "target") expect(["opus", "sol"]).toContain(result.target.targetId);
  });

  it("com o provider de planejamento esgotado, vai para o outro de planejamento", () => {
    const result = resolveForPlanning({
      candidates: [sonnet, opus, sol],
      capacity: (provider) =>
        snapshot(provider, provider === "anthropic" ? "exhausted" : "available"),
    });
    expect(result.kind === "target" && result.target.targetId).toBe("sol");
  });

  it("sem nenhum planning utilizável, cai nos demais (o julgamento não para)", () => {
    const result = resolveForPlanning({
      candidates: [sonnet, opus, sol],
      capacity: (provider) => snapshot(provider, provider === "openai" ? "exhausted" : "available"),
      exclude: ["opus"],
    });
    expect(result.kind === "target" && result.target.targetId).toBe("sonnet");
  });

  it("sem bestFor configurado, o comportamento é o de sempre", () => {
    const { bestFor: _ignored, ...plain } = sonnet;
    const result = resolveForPlanning({ candidates: [plain], capacity: free });
    expect(result.kind === "target" && result.target.targetId).toBe("sonnet");
  });
});

const haiku: RoutingCandidate = {
  targetId: "haiku",
  provider: "anthropic",
  harness: "claude-code",
  bestFor: ["everyday"],
};

describe("resolveForPurpose(everyday) — triagem, sobreposição e resumos", () => {
  it("prefere o target everyday ao de planejamento, mesmo que o Opus venha primeiro", () => {
    const result = resolveForPurpose(
      { candidates: [opus, sol, haiku], capacity: free },
      "everyday",
    );
    expect(result.kind === "target" && result.target.targetId).toBe("haiku");
  });

  it("sem target everyday, usa o de execução e nunca o só de planejamento", () => {
    const result = resolveForPurpose({ candidates: [opus, sonnet], capacity: free }, "everyday");
    expect(result.kind === "target" && result.target.targetId).toBe("sonnet");
  });

  it("se o everyday estiver esgotado, vai para outro de execução (Sol), não para o Opus", () => {
    const result = resolveForPurpose(
      {
        candidates: [opus, haiku, sol],
        capacity: (provider) =>
          snapshot(provider, provider === "anthropic" ? "exhausted" : "available"),
      },
      "everyday",
    );
    expect(result.kind === "target" && result.target.targetId).toBe("sol");
  });

  it("se só sobrar o de planejamento, ele atende (o Lead não para)", () => {
    const result = resolveForPurpose({ candidates: [opus], capacity: free }, "everyday");
    expect(result.kind === "target" && result.target.targetId).toBe("opus");
  });
});

describe("executionCandidates", () => {
  it("tira o target só de planejamento, mas mantém o que tem planning + outra finalidade", () => {
    expect(executionCandidates([opus, sonnet, sol]).map((c) => c.targetId)).toEqual([
      "sonnet",
      "sol",
    ]);
  });

  it("se só sobrar target de planejamento, ele executa", () => {
    expect(executionCandidates([opus]).map((c) => c.targetId)).toEqual(["opus"]);
  });
});
