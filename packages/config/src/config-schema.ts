import { z } from "zod";

// ~/.apo/config.yaml — config global do daemon (seção 18 do PLAN.md).

export const RoutingConfigSchema = z.object({
  capacityAware: z.boolean().default(true),
  degradedAt: z.number().min(0).max(100).default(80),
  avoidAt: z.number().min(0).max(100).default(95),
  preferLowerUsageDifference: z.number().min(0).max(100).default(20),
});

export const LimitsConfigSchema = z.object({
  maxGlobalWorkers: z.number().int().positive().default(4),
  maxWorkersPerProvider: z.number().int().positive().default(2),
  /** M2.3: worker sem saída e sem escrita em disco por esse tempo é morto como `stalled`. */
  stallTimeoutMinutes: z.number().int().positive().default(10),
});

// Targets disponíveis para o roteamento (M3.2, `ProviderRegistry`). Um target
// é um harness + provider (+ modelo opcional). O id é o que aparece em
// `--harness`, `apo providers` e `routing_decisions`.
export const ProviderTargetSchema = z.object({
  id: z.string().min(1),
  harness: z.enum(["claude-code", "codex", "gemini-cli", "antigravity", "fake"]),
  provider: z.enum(["anthropic", "openai", "google"]),
  model: z.string().optional(),
  enabled: z.boolean().default(true),
  /**
   * Só `antigravity`: libera comandos de shell no worker (testes, install, git)
   * via `--dangerously-skip-permissions`. Sem confinamento de disco — o worker
   * pode escrever fora da worktree (spikes/antigravity.md). Default: desligado.
   */
  dangerouslySkipPermissions: z.boolean().default(false),
});

export type ProviderTarget = z.infer<typeof ProviderTargetSchema>;

// Gemini fica fora do default: bloqueado na autenticação (spikes/gemini.md).
export const DEFAULT_PROVIDER_TARGETS: ProviderTarget[] = [
  {
    id: "claude-code",
    harness: "claude-code",
    provider: "anthropic",
    enabled: true,
    dangerouslySkipPermissions: false,
  },
  {
    id: "codex",
    harness: "codex",
    provider: "openai",
    enabled: true,
    dangerouslySkipPermissions: false,
  },
];

export const ProvidersConfigSchema = z.object({
  targets: z.array(ProviderTargetSchema).default(DEFAULT_PROVIDER_TARGETS),
  /** Attempts por Task antes de desistir (M3.8). Cada failover consome um. */
  maxAttemptsPerTask: z.number().int().positive().default(3),
  /** Retomada de `paused_capacity` quando nenhum provider informou `resetAt` (M3.9). */
  unknownResetRetryMinutes: z.number().int().positive().default(30),
});

export const GlobalConfigSchema = z.object({
  socketPath: z.string().default("~/.apo/apo.sock"),
  routing: RoutingConfigSchema.default({}),
  limits: LimitsConfigSchema.default({}),
  providers: ProvidersConfigSchema.default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
