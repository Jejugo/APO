// CapacityMonitor do daemon: estado em memória, persistido em
// `provider_capacity` a cada mudança (para `apo providers` e para sobreviver
// a restart) e com um evento por transição (`provider.<availability>`).

import type { EventRepository, ProviderCapacityRepository } from "@apo/db";
import { type Logger, emitEvent } from "@apo/observability";
import { CapacityMonitor } from "@apo/routing";

export async function createCapacityMonitor(options: {
  repository: ProviderCapacityRepository;
  events: EventRepository;
  logger: Logger;
  unknownResetRetryMs: number;
}): Promise<CapacityMonitor> {
  const monitor = new CapacityMonitor({
    unknownResetRetryMs: options.unknownResetRetryMs,
    sink: {
      async onChange(snapshot) {
        try {
          await options.repository.upsert({
            provider: snapshot.provider,
            availability: snapshot.availability,
            usagePercent: snapshot.usagePercent ?? null,
            resetAt: snapshot.resetAt ?? null,
            reason: snapshot.reason ?? null,
            capturedAt: snapshot.capturedAt,
          });
          await emitEvent(options.events, options.logger, {
            type: `provider.${snapshot.availability}`,
            payload: {
              provider: snapshot.provider,
              ...(snapshot.resetAt ? { resetAt: snapshot.resetAt.toISOString() } : {}),
              ...(snapshot.resetAtEstimated ? { resetAtEstimated: true } : {}),
              ...(snapshot.reason ? { reason: snapshot.reason } : {}),
            },
          });
        } catch (error) {
          options.logger.error({ error }, "falha ao persistir capacidade do provider");
        }
      },
    },
  });

  const rows = await options.repository.list();
  monitor.load(
    rows.map((row) => ({
      provider: row.provider,
      availability: row.availability,
      ...(row.usagePercent !== null ? { usagePercent: row.usagePercent } : {}),
      ...(row.resetAt !== null ? { resetAt: row.resetAt } : {}),
      ...(row.reason !== null ? { reason: row.reason } : {}),
      capturedAt: row.capturedAt,
    })),
  );
  return monitor;
}
