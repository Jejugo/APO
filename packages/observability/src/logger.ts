import pino from "pino";

// Seção 31 do PLAN.md: logging estruturado, sem dashboard.

export interface LogContext {
  featureId?: string;
  taskId?: string;
  attemptId?: string;
}

const baseLogger = pino({
  level: process.env.APO_LOG_LEVEL ?? "info",
});

export function createLogger(context: LogContext = {}) {
  return baseLogger.child(context);
}

export type Logger = ReturnType<typeof createLogger>;
