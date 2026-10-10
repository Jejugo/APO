// Classificação de falhas do Codex — único lugar do sistema que conhece o
// formato de erro desse provider (regra 4 do PLAN.md).
//
// Formato real capturado no spike M0.10 (spikes/codex.md, seção 7): um evento
// `turn.failed` cujo `error.message` é uma STRING contendo um JSON aninhado:
//   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}

import { detectLimitFailure } from "../limit-detection.js";
import type { AgentFailure } from "../types.js";

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export function parseCodexJsonl(text: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as CodexEvent);
    } catch {
      // linha não-JSON no stdout (raro, ignorada — não é um evento válido)
    }
  }
  return events;
}

export function findCodexThreadId(events: CodexEvent[]): string | undefined {
  const started = events.find((event) => event.type === "thread.started");
  const threadId = started?.thread_id;
  return typeof threadId === "string" ? threadId : undefined;
}

export function findCodexTurnFailed(events: CodexEvent[]): CodexEvent | undefined {
  return events.find((event) => event.type === "turn.failed");
}

export function classifyCodexFailure(event: CodexEvent): AgentFailure {
  const errorField = event.error;
  const rawMessage =
    typeof errorField === "object" && errorField !== null
      ? (errorField as Record<string, unknown>).message
      : undefined;
  const messageText = typeof rawMessage === "string" ? rawMessage : "Falha desconhecida do Codex";

  let status: number | undefined;
  let message = messageText;
  try {
    const parsed = JSON.parse(messageText) as { status?: number; error?: { message?: string } };
    status = parsed.status;
    message = parsed.error?.message ?? messageText;
  } catch {
    // mensagem não é um JSON aninhado — usa o texto como está
  }

  if (status === 401 || status === 403) {
    return { kind: "auth", message };
  }
  if (status === 429) {
    return { kind: "rate_limited", message };
  }
  // Limite de uso da conta ChatGPT chega como texto puro, sem status
  // (fixture real da validação do M1 — antes virava "crash" e não havia failover).
  return detectLimitFailure(message) ?? { kind: "crash", message };
}
