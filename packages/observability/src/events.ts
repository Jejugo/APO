import type { Logger } from "./logger.js";

// Seção 30 do PLAN.md: toda mudança importante produz um evento. A tabela
// `events` é append-only — é a base do `apo logs` e, futuramente, de
// TUI/analytics/audit.
//
// `EventSink` é só a forma, não importa diretamente de @apo/db: quem monta a
// EventRepository (packages/db) implementa isso estruturalmente, sem criar
// dependência de pacote entre observability e db.

export interface EventPayload {
  type: string;
  projectId?: string;
  featureId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

export interface StoredEvent extends EventPayload {
  createdAt: Date;
}

export interface EventSink {
  insert(event: StoredEvent): Promise<void>;
}

export async function emitEvent(
  sink: EventSink,
  logger: Logger,
  event: EventPayload,
): Promise<void> {
  const record: StoredEvent = { ...event, createdAt: new Date() };
  await sink.insert(record);
  logger.info({ event: record }, `event:${event.type}`);
}
