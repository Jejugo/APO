import type { ExecutionPreference } from "@apo/domain";
import { emitEvent } from "@apo/observability";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const rerouteSchema = z
  .object({
    harness: z.enum(["claude-code", "codex", "gemini-cli", "antigravity", "fake"]).optional(),
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
  })
  .refine((body) => body.harness !== undefined || body.provider !== undefined, {
    message: "informe harness ou provider",
  });

export function registerTaskRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await deps.tasks.getById(id);
    if (!task) {
      reply.code(404);
      return { error: "task não encontrada" };
    }
    return task;
  });

  app.get("/tasks/:id/attempts", async (request) => {
    const { id } = request.params as { id: string };
    return deps.taskAttempts.listByTask(id);
  });

  app.get("/tasks/:id/routing", async (request) => {
    const { id } = request.params as { id: string };
    return deps.routingDecisions.listByTask(id);
  });

  // M3.10 — reroute manual: pausa o attempt atual → handover → novo attempt no
  // target pedido, na mesma worktree. Se a Task não está rodando, só grava o
  // override para o próximo attempt.
  app.post("/tasks/:id/reroute", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = rerouteSchema.parse(request.body);
    const task = await deps.tasks.getById(id);
    if (!task) {
      reply.code(404);
      return { error: "task não encontrada" };
    }
    const preference: ExecutionPreference = {
      mode: "forced",
      ...(body.harness ? { harness: body.harness } : {}),
      ...(body.provider ? { provider: body.provider } : {}),
    };

    const interrupted = deps.featureRunner.reroute(task.featureId, id, preference);
    if (!interrupted) {
      await deps.tasks.update(id, { executionPreference: preference });
    }
    await emitEvent(deps.events, deps.logger, {
      type: "task.reroute_requested",
      featureId: task.featureId,
      taskId: id,
      payload: { preference, interrupted },
    });
    return { taskId: id, preference, interrupted };
  });
}
