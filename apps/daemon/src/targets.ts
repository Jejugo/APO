// ProviderRegistry (M3.2): os targets do config.yaml viram entradas do
// TargetRegistry, cada uma com seu harness concreto. É aqui — e só aqui, no
// daemon — que o id de um provider específico encontra a sua implementação
// (regra 4 do PLAN.md).

import type { ProviderTarget } from "@apo/config";
import {
  type AgentHarness,
  AntigravityHarness,
  ClaudeCodeHarness,
  CodexHarness,
} from "@apo/harnesses";
import type { Logger } from "@apo/observability";
import type { TargetRegistry } from "@apo/orchestrator";

function harnessFor(target: ProviderTarget): AgentHarness | undefined {
  switch (target.harness) {
    case "claude-code":
      return new ClaudeCodeHarness();
    case "codex":
      return new CodexHarness();
    case "antigravity":
      // Opt-in; sem a flag, só edita arquivos (spikes/antigravity.md).
      return new AntigravityHarness({
        dangerouslySkipPermissions: target.dangerouslySkipPermissions ?? false,
      });
    default:
      // gemini-cli: bloqueado na autenticação (spikes/gemini.md).
      // fake: só existe em testes, nunca no daemon.
      return undefined;
  }
}

export function buildTargetRegistry(targets: ProviderTarget[], logger: Logger): TargetRegistry {
  const registry: TargetRegistry = [];
  for (const target of targets) {
    if (!target.enabled) continue;
    const harness = harnessFor(target);
    if (!harness) {
      logger.warn(
        { target: target.id, harness: target.harness },
        "target ignorado: harness sem implementação disponível",
      );
      continue;
    }
    if (target.dangerouslySkipPermissions) {
      logger.warn(
        { target: target.id, harness: target.harness },
        target.harness === "antigravity"
          ? "dangerouslySkipPermissions ligado: o worker roda comandos sem confinamento de disco"
          : "dangerouslySkipPermissions só vale para antigravity — ignorado neste target",
      );
    }
    registry.push({
      candidate: {
        targetId: target.id,
        provider: target.provider,
        harness: target.harness,
        ...(target.model !== undefined ? { model: target.model } : {}),
        ...(target.effort !== undefined ? { effort: target.effort } : {}),
        ...(target.bestFor.length > 0 ? { bestFor: target.bestFor } : {}),
      },
      harness,
    });
  }
  return registry;
}
