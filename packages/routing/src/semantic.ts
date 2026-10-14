// Roteamento semântico (M5) — seções 17 e 18 do PLAN.md. O `TaskRouter`
// classifica a Task e ordena os targets; a capacity policy (determinística)
// valida a escolha por cima (M5.3). Nenhum TaskRouter é requisito estrutural:
// sem ele, ou se ele falhar, o RuleBasedRouter decide sozinho (M5.4).

import type { ProviderId } from "@apo/domain";
import type { ProviderCapacitySnapshot, RoutingCandidate, RoutingPolicy } from "./types.js";
import { DEFAULT_ROUTING_POLICY } from "./types.js";

export type Level = "low" | "medium" | "high";

export interface SemanticRoutingInput {
  task: {
    title: string;
    description: string;
    kind: "read" | "write";
    role?: string | undefined;
    expectedPaths: string[];
    origin: string;
  };
  project: { name: string };
  candidates: Array<{
    candidate: RoutingCandidate;
    capabilities: { readOnly: boolean; structuredOutput: boolean };
    capacity: ProviderCapacitySnapshot;
  }>;
}

export interface SemanticDecision {
  router: string;
  complexity: Level;
  risk: Level;
  /** Probabilidade de a Task precisar de review dedicado. */
  requiresReview: number;
  /** Targets em ordem de preferência, com a probabilidade dada pelo router. */
  ranking: Array<{ targetId: string; probability: number }>;
  confidence: number;
}

export interface TaskRouter {
  readonly id: string;
  route(input: SemanticRoutingInput, signal: AbortSignal): Promise<SemanticDecision>;
}

export interface PolicyInput {
  decision: SemanticDecision;
  candidates: RoutingCandidate[];
  capacity: (provider: ProviderId) => ProviderCapacitySnapshot;
  exclude?: string[];
  policy?: RoutingPolicy;
  /** Diferença máxima de probabilidade para dois targets contarem como equivalentes. */
  equivalenceMargin?: number;
}

export interface PolicyResult {
  target?: RoutingCandidate;
  suggested?: string;
  overriddenByPolicy: boolean;
  reason: string;
}

export const DEFAULT_EQUIVALENCE_MARGIN = 0.15;

/**
 * M5.3 — capacity policy sobre a decisão semântica:
 * 1. target esgotado/excluído nunca é escolhido (vai para o próximo do ranking);
 * 2. evita uso >= avoidAt se houver alternativa abaixo;
 * 3. entre targets equivalentes para o router (probabilidade dentro da margem),
 *    prefere available a degraded e o de menor uso quando a diferença for
 *    >= preferLowerUsageDifference. Fora da margem, a preferência técnica do
 *    router vence o uso (seção 18: "pode preferir um modelo mais ocupado").
 */
export function applyCapacityPolicy(input: PolicyInput): PolicyResult {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const margin = input.equivalenceMargin ?? DEFAULT_EQUIVALENCE_MARGIN;
  const exclude = new Set(input.exclude ?? []);
  const byId = new Map(input.candidates.map((candidate) => [candidate.targetId, candidate]));
  const probability = new Map(
    input.decision.ranking.map((entry) => [entry.targetId, entry.probability]),
  );

  const ranked = [...input.candidates]
    .map((candidate) => ({
      candidate,
      probability: probability.get(candidate.targetId) ?? 0,
      snapshot: input.capacity(candidate.provider),
    }))
    .sort((a, b) => b.probability - a.probability);
  const suggested = ranked[0]?.candidate.targetId;
  const viable = ranked.filter(
    (entry) =>
      !exclude.has(entry.candidate.targetId) && entry.snapshot.availability !== "exhausted",
  );
  if (viable.length === 0 || !byId.size) {
    return {
      ...(suggested ? { suggested } : {}),
      overriddenByPolicy: false,
      reason: "nenhum target disponível",
    };
  }

  let pick = viable[0] as (typeof viable)[number];
  const reasons: string[] = [];
  if (pick.candidate.targetId !== suggested) {
    reasons.push(`sugestão ${suggested} indisponível ou excluída`);
  }
  // Degradado (limite de uso recente) é último recurso: se há qualquer alternativa
  // utilizável, ela vence — mesmo com probabilidade bem menor do Jev. Antes, só
  // trocava quando as probabilidades estavam dentro da margem de equivalência, e a
  // Task pausava por capacidade com um provider livre ao lado.
  if (pick.snapshot.availability === "degraded") {
    const healthy = viable.find((entry) => entry.snapshot.availability !== "degraded");
    if (healthy) {
      reasons.push(
        `${pick.candidate.targetId} degradado; ${healthy.candidate.targetId} disponível`,
      );
      pick = healthy;
    }
  }

  if (policy.capacityAware) {
    const usage = (entry: (typeof viable)[number]) => entry.snapshot.usagePercent;
    const pickUsage = usage(pick);
    if (pickUsage !== undefined && pickUsage >= policy.avoidAt) {
      const below = viable.find((entry) => {
        const value = usage(entry);
        return entry !== pick && (value === undefined || value < policy.avoidAt);
      });
      if (below) {
        reasons.push(`${pick.candidate.targetId} em ${pickUsage}% (>= avoidAt ${policy.avoidAt})`);
        pick = below;
      }
    }

    const equivalents = viable.filter(
      (entry) => entry !== pick && pick.probability - entry.probability <= margin,
    );
    for (const alternative of equivalents) {
      const current = pick;
      const degradedSwap =
        current.snapshot.availability === "degraded" &&
        alternative.snapshot.availability !== "degraded";
      const currentUsage = usage(current);
      const alternativeUsage = usage(alternative);
      const usageSwap =
        currentUsage !== undefined &&
        alternativeUsage !== undefined &&
        currentUsage - alternativeUsage >= policy.preferLowerUsageDifference;
      if (degradedSwap || usageSwap) {
        reasons.push(
          degradedSwap
            ? `${current.candidate.targetId} degradado; ${alternative.candidate.targetId} equivalente e disponível`
            : `${current.candidate.targetId} em ${currentUsage}% e ${alternative.candidate.targetId} em ${alternativeUsage}%, equivalentes`,
        );
        pick = alternative;
      }
    }
  }

  const overridden = pick.candidate.targetId !== suggested;
  return {
    target: pick.candidate,
    ...(suggested ? { suggested } : {}),
    overriddenByPolicy: overridden,
    reason: overridden
      ? `política de capacidade sobrescreveu o router: ${reasons.join("; ")}`
      : `escolhido pelo ${input.decision.router} (p=${pick.probability.toFixed(2)})`,
  };
}
