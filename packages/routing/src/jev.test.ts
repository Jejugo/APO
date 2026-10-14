// M5 — os 6 casos da Phase 6 do PLAN.md com o Jev mockado (fetch falso com o
// formato real da Decisions API), mais a capacity policy por cima.

import type { ProviderId } from "@apo/domain";
import { describe, expect, it } from "vitest";
import { JevTaskRouter, buildJevPayload } from "./jev.js";
import { resolveExecutionTarget } from "./resolver.js";
import {
  type SemanticDecision,
  type SemanticRoutingInput,
  applyCapacityPolicy,
} from "./semantic.js";
import type { ProviderCapacitySnapshot, RoutingCandidate } from "./types.js";

const A: RoutingCandidate = { targetId: "alpha", provider: "openai", harness: "fake" };
const B: RoutingCandidate = { targetId: "beta", provider: "anthropic", harness: "fake" };

function snapshot(
  provider: ProviderId,
  extra: Partial<ProviderCapacitySnapshot> = {},
): ProviderCapacitySnapshot {
  return {
    provider,
    availability: "available",
    activeWorkers: 0,
    recentFailures: 0,
    capturedAt: new Date(),
    ...extra,
  };
}

function capacityOf(map: Partial<Record<ProviderId, Partial<ProviderCapacitySnapshot>>>) {
  return (provider: ProviderId) => snapshot(provider, map[provider] ?? {});
}

function decision(
  probabilities: Record<string, number>,
  extra: Partial<SemanticDecision> = {},
): SemanticDecision {
  return {
    router: "jev:test",
    complexity: "medium",
    risk: "low",
    requiresReview: 0.5,
    ranking: Object.entries(probabilities)
      .map(([targetId, probability]) => ({ targetId, probability }))
      .sort((x, y) => y.probability - x.probability),
    confidence: 0.9,
    ...extra,
  };
}

/** fetch falso que responde no formato real da Decisions API. */
function fakeJev(answers: Record<string, unknown>, status = 200) {
  const calls: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "typesafe/jev-test", answers }), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const input = (task: Partial<SemanticRoutingInput["task"]> = {}): SemanticRoutingInput => ({
  task: { title: "t", description: "d", kind: "write", expectedPaths: [], origin: "plan", ...task },
  project: { name: "p" },
  candidates: [A, B].map((candidate) => ({
    candidate,
    capabilities: { readOnly: true, structuredOutput: true },
    capacity: snapshot(
      candidate.provider,
      candidate === A ? { usagePercent: 80 } : { usagePercent: 40 },
    ),
  })),
});

const config = {
  endpoint: "https://jev.test/decisions",
  model: "~typesafe/jev-latest",
  apiKey: "k",
  timeoutMs: 1000,
};

describe("JevTaskRouter", () => {
  it("payload: Task, targets com uso/headroom e as 4 perguntas", () => {
    const payload = buildJevPayload(input({ title: "Criar endpoint" }), "~typesafe/jev-latest");
    expect(payload.state.task.title).toBe("Criar endpoint");
    expect(
      (payload.state.targets as Record<string, { usage_percent: number }>).alpha?.usage_percent,
    ).toBe(80);
    expect(Object.keys(payload.questions)).toEqual([
      "complexity",
      "risk",
      "target",
      "requires_review",
    ]);
    expect(Object.keys(payload.questions.target.criteria)).toEqual(["alpha", "beta"]);
  });

  it("payload: cada target leva o best_for (finalidade) e a instrução o menciona", () => {
    const withPurpose = input({ title: "t" });
    const [first] = withPurpose.candidates;
    if (first) first.candidate = { ...first.candidate, bestFor: ["simple"] };
    const payload = buildJevPayload(withPurpose, "m");
    const targets = payload.state.targets as Record<string, { best_for: string[] }>;
    expect(targets.alpha?.best_for).toEqual(["simple"]);
    expect(targets.beta?.best_for).toEqual([]);
    expect(payload.questions.target.instructions).toContain("best_for");
  });

  it("converte a resposta: níveis, ranking por probabilidade, review", async () => {
    const jev = fakeJev({
      complexity: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 1 },
      risk: { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 1 },
      target: {
        type: "choice",
        choice: "beta",
        probabilities: { alpha: 0.3, beta: 0.7 },
        confidence: 0.8,
      },
      requires_review: { type: "noul", noul: 0.9 },
    });
    const result = await new JevTaskRouter(config, jev.impl).route(
      input(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      router: "jev:typesafe/jev-test",
      complexity: "high",
      risk: "low",
      requiresReview: 0.9,
      confidence: 0.8,
      ranking: [
        { targetId: "beta", probability: 0.7 },
        { targetId: "alpha", probability: 0.3 },
      ],
    });
  });

  it("resposta inválida, target desconhecido ou HTTP de erro → lança (quem chama cai no RuleBasedRouter)", async () => {
    const signal = new AbortController().signal;
    await expect(
      new JevTaskRouter(config, fakeJev({ nada: 1 }).impl).route(input(), signal),
    ).rejects.toThrow();
    const unknown = fakeJev({
      complexity: { type: "score", score: 1, confidence: 1 },
      risk: { type: "score", score: 1, confidence: 1 },
      target: { type: "choice", choice: "gamma", probabilities: { gamma: 1 }, confidence: 1 },
      requires_review: { type: "noul", noul: 0.1 },
    });
    await expect(new JevTaskRouter(config, unknown.impl).route(input(), signal)).rejects.toThrow(
      "desconhecido",
    );
    await expect(
      new JevTaskRouter(config, fakeJev({}, 500).impl).route(input(), signal),
    ).rejects.toThrow("500");
  });
});

describe("capacity policy sobre o Jev (Phase 6)", () => {
  const candidates = [A, B];

  it("simple task: segue a escolha do Jev", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.9, beta: 0.1 }, { complexity: "low" }),
      candidates,
      capacity: capacityOf({}),
    });
    expect(result).toMatchObject({ target: A, overriddenByPolicy: false });
  });

  it("complex task: o mais capaz vence mesmo mais ocupado (fora da margem de equivalência)", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.85, beta: 0.15 }, { complexity: "high" }),
      candidates,
      capacity: capacityOf({ openai: { usagePercent: 80 }, anthropic: { usagePercent: 40 } }),
    });
    expect(result).toMatchObject({ target: A, overriddenByPolicy: false });
  });

  it("high-risk task: a decisão carrega o risco (o review do M4 roda sempre)", () => {
    const result = resolveExecutionTarget({
      candidates,
      capacity: capacityOf({}),
      semantic: decision({ alpha: 0.6, beta: 0.4 }, { risk: "high", requiresReview: 0.95 }),
    });
    expect(result).toMatchObject({ kind: "target", resolutionSource: "jev", target: A });
  });

  it("provider near quota: A 80% e B 40% equivalentes → B, com override da política", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.55, beta: 0.45 }),
      candidates,
      capacity: capacityOf({ openai: { usagePercent: 80 }, anthropic: { usagePercent: 40 } }),
    });
    expect(result).toMatchObject({ target: B, suggested: "alpha", overriddenByPolicy: true });
    expect(result.reason).toContain("80%");
  });

  it("provider exhausted: a sugestão do Jev é descartada e vai para o próximo do ranking", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.95, beta: 0.05 }),
      candidates,
      capacity: capacityOf({ openai: { availability: "exhausted" } }),
    });
    expect(result).toMatchObject({ target: B, overriddenByPolicy: true });
  });

  it("provider degradado (limite recente) perde para um saudável mesmo com probabilidade muito menor", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.72, beta: 0.28 }, { complexity: "high" }),
      candidates,
      capacity: capacityOf({ anthropic: { availability: "degraded" } }),
    });
    expect(result).toMatchObject({ target: A, overriddenByPolicy: false });
    const degraded = applyCapacityPolicy({
      decision: decision({ alpha: 0.72, beta: 0.28 }, { complexity: "high" }),
      candidates,
      capacity: capacityOf({ openai: { availability: "degraded" } }),
    });
    expect(degraded).toMatchObject({ target: B, overriddenByPolicy: true });
    expect(degraded.reason).toContain("degradado");
  });

  it("provider unknown: é elegível (sem dado ≠ indisponível)", () => {
    const result = applyCapacityPolicy({
      decision: decision({ alpha: 0.7, beta: 0.3 }),
      candidates,
      capacity: capacityOf({ openai: { availability: "unknown" } }),
    });
    expect(result).toMatchObject({ target: A, overriddenByPolicy: false });
  });

  it("acima do avoidAt troca mesmo fora da margem; degradado perde para equivalente disponível", () => {
    expect(
      applyCapacityPolicy({
        decision: decision({ alpha: 0.9, beta: 0.1 }),
        candidates,
        capacity: capacityOf({ openai: { usagePercent: 97 } }),
      }).target,
    ).toEqual(B);
    expect(
      applyCapacityPolicy({
        decision: decision({ alpha: 0.5, beta: 0.45 }),
        candidates,
        capacity: capacityOf({ openai: { availability: "degraded" } }),
      }).target,
    ).toEqual(B);
  });

  it("todos esgotados → resolver cai no RuleBasedRouter e devolve no_capacity", () => {
    const result = resolveExecutionTarget({
      candidates,
      capacity: capacityOf({
        openai: { availability: "exhausted" },
        anthropic: { availability: "exhausted" },
      }),
      semantic: decision({ alpha: 0.5, beta: 0.5 }),
    });
    expect(result.kind).toBe("no_capacity");
  });

  it("override forced/preferred ignora o Jev", () => {
    const result = resolveExecutionTarget({
      candidates,
      capacity: capacityOf({}),
      featurePreference: { mode: "forced", provider: "anthropic" },
      semantic: decision({ alpha: 1, beta: 0 }),
    });
    expect(result).toMatchObject({
      kind: "target",
      target: B,
      resolutionSource: "feature_override",
    });
  });
});
