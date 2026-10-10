import Fastify from "fastify";
import { ZodError } from "zod";
import { registerFeatureRoutes } from "./routes/features.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { ServerDeps } from "./server-deps.js";

const startedAt = Date.now();

export function buildServer(deps: ServerDeps) {
  // Fastify gerencia seu próprio ciclo de log de acesso; desligado aqui
  // porque isso é IPC local CLI↔daemon (seção 2 do TECHNICAL_PLAN.md), não
  // tráfego que precise de access log próprio. `deps.logger` (pino) é quem
  // registra os eventos de negócio dentro dos handlers.
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return { error: "validação falhou", issues: error.issues };
    }
    deps.logger.error({ error }, "erro não tratado numa rota do daemon");
    reply.code(500);
    return { error: "erro interno" };
  });

  app.get("/health", async () => ({
    status: "ok",
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
  }));

  registerProjectRoutes(app, deps);
  registerFeatureRoutes(app, deps);
  registerTaskRoutes(app, deps);

  return app;
}

export type { ServerDeps };
