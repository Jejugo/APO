// Escolha do target para julgamento estruturado (Lead, Reviewer) dentro do
// graph. Só entram targets com saída estruturada confiável. `avoidProvider`
// implementa a dica `preferDifferentProviderFrom` do M4.3: o review prefere
// um provider diferente do que mais implementou, mas não deixa de rodar se
// ele for o único com capacidade.

import type { ProviderId } from "@apo/domain";
import { type RoutingPolicy, resolveExecutionTarget } from "@apo/routing";
import { AgentRunnerImpl } from "./agent-runner.js";
import type { ExecutionTargetEntry, TargetRegistry } from "./harness-registry.js";
import type { EngineDeps } from "./task-runner.js";

export interface Judge {
  entry: ExecutionTargetEntry;
  runner: AgentRunnerImpl;
}

export function pickJudge(
  deps: Pick<EngineDeps, "targets" | "capacity"> & { routingPolicy?: RoutingPolicy | undefined },
  avoidProvider?: ProviderId,
): Judge | undefined {
  const structured: TargetRegistry = deps.targets.filter(
    (entry) => entry.harness.getCapabilities().supportsOutputSchema,
  );
  const resolve = (exclude: string[]) =>
    resolveExecutionTarget({
      candidates: structured.map((entry) => entry.candidate),
      capacity: (provider) => deps.capacity.get(provider),
      exclude,
      ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
    });
  const avoided = avoidProvider
    ? structured
        .filter((entry) => entry.candidate.provider === avoidProvider)
        .map((entry) => entry.candidate.targetId)
    : [];
  let resolved = resolve(avoided);
  if (resolved.kind !== "target" && avoided.length > 0) resolved = resolve([]);
  if (resolved.kind !== "target") return undefined;
  const targetId = resolved.target.targetId;
  const entry = structured.find((candidate) => candidate.candidate.targetId === targetId);
  return entry ? { entry, runner: new AgentRunnerImpl(entry.harness) } : undefined;
}

const CAPACITY_KINDS = new Set(["rate_limited", "quota_exhausted", "auth"]);

export type JudgedResult<T> =
  | { kind: "ok"; value: T; judge: Judge }
  | { kind: "failed"; error: string; judge: Judge }
  | { kind: "no_capacity"; reason: string };

/**
 * Roda um julgamento trocando de target quando o atual bate em limite de
 * capacidade (registra no CapacityMonitor, que tira o provider da próxima
 * escolha). Achado do E2E do M7: um "session limit" no review virava
 * needs_human em vez de failover/pausa.
 */
export async function withJudge<T>(
  deps: Pick<EngineDeps, "targets" | "capacity"> & { routingPolicy?: RoutingPolicy | undefined },
  avoidProvider: ProviderId | undefined,
  attempt: (judge: Judge) => Promise<{
    value?: T;
    error?: string;
    failure?: { kind: string; message: string; resetAt?: Date };
  }>,
): Promise<JudgedResult<T>> {
  for (let tries = 0; tries < Math.max(1, deps.targets.length); tries += 1) {
    const judge = pickJudge(deps, avoidProvider);
    if (!judge)
      return { kind: "no_capacity", reason: "nenhum provider com capacidade para julgar" };
    const result = await attempt(judge);
    if (result.value !== undefined) return { kind: "ok", value: result.value, judge };
    if (result.failure && CAPACITY_KINDS.has(result.failure.kind)) {
      deps.capacity.recordFailure(
        judge.entry.harness.provider,
        result.failure as Parameters<typeof deps.capacity.recordFailure>[1],
      );
      continue;
    }
    return { kind: "failed", error: result.error ?? result.failure?.message ?? "falhou", judge };
  }
  return { kind: "no_capacity", reason: "todos os providers bateram limite" };
}
