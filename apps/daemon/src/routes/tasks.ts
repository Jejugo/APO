import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../server-deps.js";

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
}
