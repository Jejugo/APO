import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerChatRoutes } from "./routes/chat.js";
import { registerFeatureRoutes } from "./routes/features.js";
import { registerLiveRoutes } from "./routes/live.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { ServerDeps } from "./server-deps.js";

const startedAt = Date.now();

export interface ServerOptions {
  /**
   * M6.7: exigido em toda requisição (`Authorization: Bearer <token>`). Usado
   * no listener TCP (IP do Tailscale); o socket Unix local não precisa.
   */
  authToken?: string;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function buildServer(deps: ServerDeps, options: ServerOptions = {}) {
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

  if (options.authToken) {
    const token = options.authToken;
    app.addHook("onRequest", async (request, reply) => {
      if (!tokenMatches(request.headers.authorization, token)) {
        reply.code(401);
        await reply.send({ error: "token inválido ou ausente" });
      }
    });
  }

  // M6.9: estado do Postgres e dos providers, além de "o processo está vivo".
  app.get("/health", async (_request, reply) => {
    const details = (await deps.health?.()) ?? {};
    const degraded = details.postgres !== undefined && details.postgres !== "ok";
    if (degraded) reply.code(503);
    return {
      status: degraded ? "degraded" : "ok",
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      ...details,
    };
  });

  registerProjectRoutes(app, deps);
  registerFeatureRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerLiveRoutes(app, deps);
  registerQuestionRoutes(app, deps);

  return app;
}

export type { ServerDeps };
