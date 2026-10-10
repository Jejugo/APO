// ExecutionTargetResolver (M3.5) — seção 6.5 do TECHNICAL_PLAN.md e 14.1 do
// PLAN.md, como função pura:
//
//   preferência efetiva = Task override → Feature override → (router)
//   forced    → usa o target; indisponível → needs_human (sem trocar de provider)
//   preferred → usa o target se disponível; senão router, registrando o motivo
//   auto      → router
//
// "Role preference" (project.yaml) entra junto com o RoleRegistry (M2.15).

import type { ExecutionPreference, ResolutionSource } from "@apo/domain";
import { type RouteResult, routeTask } from "./rule-based-router.js";
import type { ProviderCapacitySnapshot, RoutingCandidate, RoutingPolicy } from "./types.js";

export interface ResolveInput {
  candidates: RoutingCandidate[];
  capacity: (provider: RoutingCandidate["provider"]) => ProviderCapacitySnapshot;
  taskPreference?: ExecutionPreference | null;
  featurePreference?: ExecutionPreference | null;
  /** Targets a evitar (só vale para preferred/auto; forced nunca troca). */
  exclude?: string[];
  policy?: RoutingPolicy;
}

export type ResolveResult =
  | {
      kind: "target";
      target: RoutingCandidate;
      resolutionSource: ResolutionSource;
      reason: string;
      route?: RouteResult;
    }
  | { kind: "needs_human"; reason: string }
  | { kind: "no_capacity"; reason: string; route: RouteResult };

export function matchesPreference(
  candidate: RoutingCandidate,
  preference: ExecutionPreference,
): boolean {
  if (preference.harness !== undefined && preference.harness !== candidate.harness) return false;
  if (preference.provider !== undefined && preference.provider !== candidate.provider) return false;
  if (
    preference.model !== undefined &&
    candidate.model !== undefined &&
    preference.model !== candidate.model
  ) {
    return false;
  }
  return preference.harness !== undefined || preference.provider !== undefined;
}

function isUsable(snapshot: ProviderCapacitySnapshot): boolean {
  return snapshot.availability !== "exhausted" && snapshot.availability !== "degraded";
}

export function resolveExecutionTarget(input: ResolveInput): ResolveResult {
  const overrides: Array<[ExecutionPreference | null | undefined, ResolutionSource]> = [
    [input.taskPreference, "task_override"],
    [input.featurePreference, "feature_override"],
  ];
  const effective = overrides.find(([preference]) => preference && preference.mode !== "auto");

  if (effective) {
    const [preference, source] = effective as [ExecutionPreference, ResolutionSource];
    const match = input.candidates.find((candidate) => matchesPreference(candidate, preference));

    if (preference.mode === "forced") {
      if (!match) {
        return {
          kind: "needs_human",
          reason: "target forçado não existe nos targets configurados",
        };
      }
      const snapshot = input.capacity(match.provider);
      if (!isUsable(snapshot)) {
        return {
          kind: "needs_human",
          reason: `target forçado "${match.targetId}" está ${snapshot.availability}; modo forced nunca troca de provider`,
        };
      }
      return {
        kind: "target",
        target: match,
        resolutionSource: source,
        reason: "preferência forced",
      };
    }

    // preferred
    const excluded = new Set(input.exclude ?? []);
    if (match && !excluded.has(match.targetId) && isUsable(input.capacity(match.provider))) {
      return {
        kind: "target",
        target: match,
        resolutionSource: source,
        reason: "preferência preferred disponível",
      };
    }
    const route = routeTask({
      candidates: input.candidates,
      capacity: input.capacity,
      ...(input.exclude ? { exclude: input.exclude } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
    });
    if (!route.target) {
      return { kind: "no_capacity", reason: route.reason, route };
    }
    return {
      kind: "target",
      target: route.target,
      resolutionSource: "rule_router",
      reason: `preferido indisponível (${match ? match.targetId : "sem match"}); ${route.reason}`,
      route,
    };
  }

  const route = routeTask({
    candidates: input.candidates,
    capacity: input.capacity,
    ...(input.exclude ? { exclude: input.exclude } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
  });
  if (!route.target) {
    return { kind: "no_capacity", reason: route.reason, route };
  }
  return {
    kind: "target",
    target: route.target,
    resolutionSource: "rule_router",
    reason: route.reason,
    route,
  };
}
