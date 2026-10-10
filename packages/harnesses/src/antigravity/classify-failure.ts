// Saída do `agy -p --output-format json` (spike M2.23): um único objeto JSON.

import { detectLimitFailure } from "../limit-detection.js";
import type { AgentFailure } from "../types.js";

export interface AntigravityResultJson {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
}

export function parseAntigravityJson(stdout: string): AntigravityResultJson | undefined {
  // O JSON é a última linha não vazia; avisos podem vir antes.
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as AntigravityResultJson;
    } catch {
      // continua procurando
    }
  }
  return undefined;
}

export function classifyAntigravityFailure(
  result: AntigravityResultJson | undefined,
  stderr: string,
  exitCode: number | undefined,
): AgentFailure {
  const message = result?.error ?? (stderr.trim() || `agy terminou com exit ${exitCode ?? "?"}`);
  return detectLimitFailure(message) ?? { kind: "crash", message };
}
