// RuleBasedRouter (M3.6) — seção 18 do PLAN.md, passos 1, 2, 3, 6 e 7 (o Jev,
// passos 4 e 5, entra no M5):
//   1. elimina providers `exhausted` (e targets excluídos pelo chamador);
//   2. separa em faixas: available/unknown antes de degraded;
//   3. dentro da faixa, aplica a capacity policy quando houver `usagePercent`:
//      evita >= avoidAt se houver alternativa e prefere o de menor uso quando
//      a diferença for >= preferLowerUsageDifference;
//   4. desempata por workers ativos, depois falhas recentes, depois a ordem do config.
// Determinístico: mesmas entradas → mesma escolha.

import type { ProviderId } from "@apo/domain";
import type { ProviderCapacitySnapshot, RoutingCandidate, RoutingPolicy } from "./types.js";
import { DEFAULT_ROUTING_POLICY } from "./types.js";

export interface RouteInput {
  candidates: RoutingCandidate[];
  capacity: (provider: ProviderId) => ProviderCapacitySnapshot;
  /** Targets a evitar nesta escolha (ex.: o que acabou de falhar com crash). */
  exclude?: string[];
  policy?: RoutingPolicy;
}

export interface RouteResult {
  target?: RoutingCandidate;
  reason: string;
  considered: Array<{ targetId: string; availability: string; eliminated?: string }>;
}

export function routeTask(input: RouteInput): RouteResult {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const exclude = new Set(input.exclude ?? []);
  const considered: RouteResult["considered"] = [];

  const viable: Array<{
    candidate: RoutingCandidate;
    snapshot: ProviderCapacitySnapshot;
    index: number;
  }> = [];
  input.candidates.forEach((candidate, index) => {
    const snapshot = input.capacity(candidate.provider);
    if (exclude.has(candidate.targetId)) {
      considered.push({
        targetId: candidate.targetId,
        availability: snapshot.availability,
        eliminated: "excluído",
      });
      return;
    }
    if (snapshot.availability === "exhausted") {
      considered.push({
        targetId: candidate.targetId,
        availability: snapshot.availability,
        eliminated: "esgotado",
      });
      return;
    }
    considered.push({ targetId: candidate.targetId, availability: snapshot.availability });
    viable.push({ candidate, snapshot, index });
  });

  if (viable.length === 0) {
    return { reason: "nenhum target disponível", considered };
  }

  if (!policy.capacityAware) {
    const first = viable[0];
    return first
      ? {
          target: first.candidate,
          reason: "capacityAware desligado: primeiro target viável",
          considered,
        }
      : { reason: "nenhum target disponível", considered };
  }

  const tier = (snapshot: ProviderCapacitySnapshot) =>
    snapshot.availability === "degraded" ? 1 : 0;
  const bestTier = Math.min(...viable.map((entry) => tier(entry.snapshot)));
  let pool = viable.filter((entry) => tier(entry.snapshot) === bestTier);

  const belowAvoid = pool.filter(
    (entry) =>
      entry.snapshot.usagePercent === undefined || entry.snapshot.usagePercent < policy.avoidAt,
  );
  if (belowAvoid.length > 0) {
    pool = belowAvoid;
  }

  pool.sort((a, b) => {
    const ua = a.snapshot.usagePercent;
    const ub = b.snapshot.usagePercent;
    if (
      ua !== undefined &&
      ub !== undefined &&
      Math.abs(ua - ub) >= policy.preferLowerUsageDifference
    ) {
      return ua - ub;
    }
    if (a.snapshot.activeWorkers !== b.snapshot.activeWorkers) {
      return a.snapshot.activeWorkers - b.snapshot.activeWorkers;
    }
    if (a.snapshot.recentFailures !== b.snapshot.recentFailures) {
      return a.snapshot.recentFailures - b.snapshot.recentFailures;
    }
    return a.index - b.index;
  });

  const chosen = pool[0];
  if (!chosen) {
    return { reason: "nenhum target disponível", considered };
  }
  const reason =
    bestTier === 1
      ? "só restaram targets degradados; escolhido o melhor deles"
      : `escolhido por capacidade (${chosen.snapshot.availability})`;
  return { target: chosen.candidate, reason, considered };
}
