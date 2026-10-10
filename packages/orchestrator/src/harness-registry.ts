// Targets de execução disponíveis. O registry concreto (quais harnesses
// existem, com quais providers) é montado por quem sobe o daemon
// (apps/daemon), a partir do config.yaml — este pacote só trabalha com o
// id genérico do target, nunca com o id de um provider específico como
// literal (regra 4 do PLAN.md, verificado pelo teste de arquitetura M1.14).

import type { AgentHarness } from "@apo/harnesses";
import type { RoutingCandidate } from "@apo/routing";

export interface ExecutionTargetEntry {
  candidate: RoutingCandidate;
  harness: AgentHarness;
}

export type TargetRegistry = ExecutionTargetEntry[];

export function findTarget(
  registry: TargetRegistry,
  targetId: string,
): ExecutionTargetEntry | undefined {
  return registry.find((entry) => entry.candidate.targetId === targetId);
}

export function candidatesOf(registry: TargetRegistry): RoutingCandidate[] {
  return registry.map((entry) => entry.candidate);
}
