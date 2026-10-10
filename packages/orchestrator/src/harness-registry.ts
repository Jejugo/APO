// M1: seleção de harness é manual (ROADMAP.md, decisão 1 — ExecutionPreference
// "forced" via flag --harness). O registry concreto (quais harnesses existem)
// é montado por quem sobe o daemon (apps/daemon), não aqui — este pacote só
// resolve por id genérico, nunca conhece o id de nenhum provider específico
// como literal (regra 4 do PLAN.md, verificado pelo teste de arquitetura M1.14).

import type { HarnessId } from "@apo/domain";
import type { AgentHarness } from "@apo/harnesses";

export type HarnessRegistry = Partial<Record<HarnessId, AgentHarness>>;

export function resolveHarness(
  registry: HarnessRegistry,
  harnessId: HarnessId | undefined,
): AgentHarness {
  if (!harnessId) {
    throw new Error(
      "Task sem executionPreference.harness — seleção de harness ainda é manual no M1.",
    );
  }
  const harness = registry[harnessId];
  if (!harness) {
    throw new Error(`Harness "${harnessId}" não está registrado neste daemon.`);
  }
  return harness;
}
