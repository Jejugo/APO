import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server-deps.js";

// M3.10 — `apo providers`. Mostra `unknown` quando não há dado; nunca
// inventa percentual (seção 15 do PLAN.md).
export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/providers", async () =>
    deps.targets.map((entry) => {
      const snapshot = deps.capacity.get(entry.candidate.provider);
      return {
        targetId: entry.candidate.targetId,
        harness: entry.candidate.harness,
        provider: entry.candidate.provider,
        ...(entry.candidate.model !== undefined ? { model: entry.candidate.model } : {}),
        availability: snapshot.availability,
        usagePercent: snapshot.usagePercent ?? null,
        resetAt: snapshot.resetAt?.toISOString() ?? null,
        resetAtEstimated: snapshot.resetAtEstimated ?? false,
        reason: snapshot.reason ?? null,
        activeWorkers: snapshot.activeWorkers,
        recentFailures: snapshot.recentFailures,
      };
    }),
  );
}
