import { randomUUID } from "node:crypto";
import { emitEvent } from "@apo/observability";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const createProjectSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  defaultBranch: z.string().default("main"),
  configSnapshot: z.record(z.string(), z.unknown()).optional(),
});

export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/projects", async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const project = await deps.projects.create({
      id: randomUUID(),
      name: body.name,
      repoPath: body.repoPath,
      defaultBranch: body.defaultBranch,
      ...(body.configSnapshot !== undefined ? { configSnapshot: body.configSnapshot } : {}),
    });
    if (!project) {
      reply.code(500);
      return { error: "falha ao criar project" };
    }

    // M1.15: só o registro "lead", criado junto do Project.
    await deps.projectAgents.create({
      id: randomUUID(),
      projectId: project.id,
      roleId: "lead",
      lifecycle: "persistent",
      enabled: true,
    });

    await emitEvent(deps.events, deps.logger, { type: "project.created", projectId: project.id });
    reply.code(201);
    return project;
  });

  app.get("/projects", async () => deps.projects.list());

  app.get("/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await deps.projects.getById(id);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }
    return project;
  });
}
