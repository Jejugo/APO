// Contrato central dos harnesses de CLI (TECHNICAL_PLAN.md seção 6.1).
//
// Fechado com dados reais dos spikes M0.9/M0.10 (spikes/claude-code.md,
// spikes/codex.md) — não é mais hipótese. CapacityCollector (seção 6.1,
// "dentro de cada harness") fica fora do M1: não é uma entrega de M1.4 e só
// tem consumidor real a partir do CapacityMonitor (M3.3).

import type { HarnessId, ProviderId } from "@apo/domain";

export type JsonSchema = Record<string, unknown>;

export type FailureKind =
  | "rate_limited" // temporário, há resetAt     → provider degraded
  | "quota_exhausted" // sem capacidade no período  → provider exhausted
  | "auth" // credencial inválida        → provider unavailable, alerta humano
  | "timeout"
  | "stalled" // sem saída nem mudança em disco por N minutos
  | "crash" // exit code inesperado
  | "cancelled"
  | "invalid_output"; // saída não bate com outputSchema

export interface AgentFailure {
  kind: FailureKind;
  message: string;
  resetAt?: Date;
}

export type AgentExecutionMode = "read-only" | "workspace-write";

export interface AgentExecutionInput {
  prompt: string;
  cwd: string;
  mode: AgentExecutionMode;
  /** Só relevante em "workspace-write". Confirmado no spike M0.10: o Codex
   * bloqueia rede por padrão em workspace-write; o Claude Code nunca sandboxa
   * rede (ver `AgentCapabilities.supportsNetworkToggle`). */
  networkAccess: boolean;
  model?: string;
  outputSchema?: JsonSchema;
  /** Obrigatório — ver TECHNICAL_PLAN.md seção 6.1: credencial inválida não
   * falha rápido em nenhum dos dois CLIs reais (~4,4min no Claude Code, ~10-15s
   * de retry no Codex). Sem timeout, isso trava um worker indefinidamente. */
  timeoutMs: number;
  /** Sem saída e sem escrita em disco por esse tempo → falha `stalled` (M2.3). */
  stallTimeoutMs?: number;
  logPath: string;
  /** Environment completo do processo do CLI. Ausente → `buildWorkerEnvironment()`
   * (allowlist). Nunca é o `process.env` do daemon (seção 6.3). */
  env?: Record<string, string>;
  /** Diretórios fora do `cwd` onde o worker pode escrever (ex.: o diretório do
   * `$APO_RESULT_PATH`, que fica fora do repo — seção 6.3). Vira `--add-dir`. */
  extraWritableDirs?: string[];
}

export interface ResumeExecutionInput extends AgentExecutionInput {
  sessionId: string;
}

export interface AgentExecutionResult {
  outcome: "success" | "failure";
  failure?: AgentFailure;
  /** Habilita resume nativo. Confirmado: resume é de sessão, não de turno em
   * andamento — um turno morto sem conteúdo persistido é reexecutado do zero. */
  sessionId?: string;
  finalMessage?: string;
  structuredOutput?: unknown;
  durationMs: number;
}

export interface AgentCapabilities {
  supportsReadOnly: boolean;
  supportsResume: boolean;
  supportsOutputSchema: boolean;
  /** Confirmado no spike: Claude Code não sandboxa rede (sempre `false` —
   * não há flag para alternar); Codex sim, via `-c sandbox_workspace_write.network_access`. */
  supportsNetworkToggle: boolean;
}

export interface AgentHarness {
  readonly id: HarnessId;
  readonly provider: ProviderId;

  getCapabilities(): AgentCapabilities;

  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult>;

  // Só dentro do mesmo harness. Entre providers vale o handover (TaskHandover, M3).
  resume?(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult>;
}
