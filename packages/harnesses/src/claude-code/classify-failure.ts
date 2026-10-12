// Classificação de falhas do Claude Code — único lugar do sistema que conhece
// o formato de erro desse provider (regra 4 do PLAN.md).
//
// Formatos reais capturados no spike M0.9 (spikes/claude-code.md, seção 7):
//   modelo inexistente  → { is_error: true, api_error_status: 404, result: "..." }
//   credencial inválida → { is_error: true, api_error_status: 401, result: "Invalid API key · Fix external API key" }

import { detectLimitFailure } from "../limit-detection.js";
import type { AgentFailure } from "../types.js";

export interface ClaudeCodeResultJson {
  type: string;
  subtype?: string;
  is_error: boolean;
  terminal_reason?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  permission_denials?: unknown[];
  api_error_status?: number | null;
}

/** Retorna `undefined` quando a execução não é uma falha. */
export function classifyClaudeCodeFailure(json: ClaudeCodeResultJson): AgentFailure | undefined {
  if (!json.is_error) {
    return undefined;
  }

  const status = json.api_error_status ?? undefined;
  const message = json.result ?? "Erro desconhecido do Claude Code";

  if (status === 401 || status === 403) {
    return { kind: "auth", message };
  }
  if (status === 429) {
    return { kind: "rate_limited", message };
  }
  // Limite da assinatura pode vir sem status numérico — só no texto.
  const limit = detectLimitFailure(message);
  if (limit) {
    return limit;
  }
  // 404 (modelo inexistente) e outros status de API caem aqui — são erros de
  // configuração/execução, não condições retomáveis automaticamente.
  return { kind: "crash", message };
}

/**
 * `--output-format stream-json`: um evento JSON por linha; o resultado final é
 * o último evento `type: "result"` (mesmo formato do `--output-format json`).
 */
export function parseClaudeCodeStream(stdout: string): ClaudeCodeResultJson | undefined {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as ClaudeCodeResultJson;
      if (event.type === "result") return event;
    } catch {
      // linha parcial ou não-JSON: ignora
    }
  }
  return undefined;
}
