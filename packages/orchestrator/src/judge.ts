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
