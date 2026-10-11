// JevTaskRouter (M5.2) — Jev via OpenRouter Decisions API. Formato confirmado
// contra a API real (2026-10-11):
//   pergunta `noul`   → { noul: p }
//   pergunta `choice` → { choice, probabilities: {opção: p}, confidence }
//   pergunta `score`  → { score: n, legend, probabilities, confidence } — `n` pode
//                       ser fracionado (valor esperado entre níveis, ex.: 1.6)
// A resposta é validada com zod; qualquer desvio vira erro, e quem chama cai
// no RuleBasedRouter (M5.4).

import { z } from "zod";
import type { Level, SemanticDecision, SemanticRoutingInput, TaskRouter } from "./semantic.js";

export interface JevConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

const LEVELS: Level[] = ["low", "medium", "high"];

const ScoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number().min(0).max(2),
  confidence: z.number(),
});
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });

const JevResponse = z.object({
  model: z.string(),
  answers: z.object({
    complexity: ScoreAnswer,
    risk: ScoreAnswer,
    target: ChoiceAnswer,
    requires_review: NoulAnswer,
  }),
});

export function buildJevPayload(input: SemanticRoutingInput, model: string) {
  const targets: Record<string, unknown> = {};
  const choices: Record<string, string> = {};
  for (const { candidate, capabilities, capacity } of input.candidates) {
    targets[candidate.targetId] = {
      provider: candidate.provider,
      harness: candidate.harness,
      model: candidate.model ?? "padrão do harness",
      capabilities,
      availability: capacity.availability,
      usage_percent: capacity.usagePercent ?? null,
      active_workers: capacity.activeWorkers,
      recent_failures: capacity.recentFailures,
      reset_at: capacity.resetAt?.toISOString() ?? null,
    };
    choices[candidate.targetId] =
      `Execute the task on target "${candidate.targetId}" (${candidate.provider}/${candidate.harness}${candidate.model ? `/${candidate.model}` : ""}).`;
  }
  return {
    model,
    state: {
      task: {
        title: input.task.title,
        description: input.task.description,
        kind: input.task.kind,
        role: input.task.role ?? null,
        files_or_modules: input.task.expectedPaths,
        origin: input.task.origin,
      },
      project: input.project,
      targets,
    },
    questions: {
      complexity: {
        type: "score",
        instructions: "How complex is `task` for a coding agent?",
        criteria: [
          "Low: trivial or localized change, no design decisions.",
          "Medium: a few files, some design decisions within existing patterns.",
          "High: cross-cutting change, new architecture, many files, or subtle logic.",
        ],
      },
      risk: {
        type: "score",
        instructions:
          "How risky is `task` if done wrong (security, data loss, breaking existing behavior)?",
        criteria: [
          "Low: isolated, easy to verify and revert.",
          "Medium: touches shared code or behavior users depend on.",
          "High: security, authentication, payments, data migrations, or irreversible effects.",
        ],
      },
      target: {
        type: "choice",
        instructions:
          "Which entry of `targets` should execute `task`? Judge technical fit first. When targets are similarly suitable, prefer the one with more headroom: lower usage_percent, available over degraded, fewer active_workers and recent_failures. Never pick an exhausted target. A busier target is acceptable only if it is clearly more capable for this task.",
        criteria: choices,
      },
      requires_review: {
        type: "noul",
        instructions: "Does `task` need a careful independent code review before merge?",
        criteria: {
          true: "Non-trivial logic, risky areas, or changes other code depends on.",
          false: "Trivial, cosmetic, or documentation-only change.",
        },
      },
    },
  };
}

export class JevTaskRouter implements TaskRouter {
  readonly id = "jev";

  constructor(
    private readonly config: JevConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async route(input: SemanticRoutingInput, signal: AbortSignal): Promise<SemanticDecision> {
    if (input.candidates.length === 0) throw new Error("Jev: nenhum candidato");
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildJevPayload(input, this.config.model)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Jev respondeu ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JevResponse.parse(JSON.parse(text));
    const { complexity, risk, target, requires_review } = parsed.answers;
    const known = new Set(input.candidates.map((entry) => entry.candidate.targetId));
    const ranking = Object.entries(target.probabilities)
      .filter(([targetId]) => known.has(targetId))
      .map(([targetId, probability]) => ({ targetId, probability }))
      .sort((a, b) => b.probability - a.probability);
    if (!known.has(target.choice) || ranking.length === 0) {
      throw new Error(`Jev escolheu um target desconhecido: ${target.choice}`);
    }
    return {
      router: `jev:${parsed.model}`,
      complexity: LEVELS[Math.round(complexity.score)] ?? "medium",
      risk: LEVELS[Math.round(risk.score)] ?? "medium",
      requiresReview: requires_review.noul,
      ranking,
      confidence: target.confidence,
    };
  }
}
