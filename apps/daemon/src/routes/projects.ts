import { randomUUID } from "node:crypto";
import { loadRoleRegistry } from "@apo/config";
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

const memorySchema = z.object({
  kind: z.enum(["convention", "decision", "pattern", "failure", "correction"]),
  title: z.string().min(1),
  content: z.string().min(1),
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
    // M5.8: primeira indexação em segundo plano; as seguintes são incrementais.
    if (deps.memory) {
      const memory = deps.memory;
      void memory
        .ingestProject(project.id, project.repoPath)
        .then((report) =>
          deps.logger.info({ projectId: project.id, ...report }, "memória: Project indexado"),
        )
        .catch((error: unknown) =>
          deps.logger.warn({ error, projectId: project.id }, "memória: falha ao indexar"),
        );
    }
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

  // M2.17 — roles resolvidos: embutidos + overrides de <repo>/.apo/roles/*.yaml.
  app.get("/projects/:id/roles", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await deps.projects.getById(id);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }
    try {
      return [...loadRoleRegistry(project.repoPath).values()];
    } catch (error) {
      reply.code(422);
      return { error: `role inválido em .apo/roles: ${(error as Error).message}` };
    }
  });

  // M5 — memória do Project: listar/buscar, registrar convenção, reindexar, apagar.
  app.get("/projects/:id/memories", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { q, kind, limit } = request.query as { q?: string; kind?: string; limit?: string };
    if (!deps.memory) {
      reply.code(503);
      return { error: "memória desligada (memory.enabled: false)" };
    }
    if (q) {
      return deps.memory.retrieve(id, q, { limit: Number(limit ?? 8), maxChars: 50_000 });
    }
    return deps.memory.list(id, kind);
  });

  app.post("/projects/:id/memories", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = memorySchema.parse(request.body);
    if (!deps.memory) {
      reply.code(503);
      return { error: "memória desligada (memory.enabled: false)" };
    }
    const inserted = await deps.memory.remember(id, "manual", [body]);
    return { inserted };
  });

  app.post("/projects/:id/memories/ingest", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await deps.projects.getById(id);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }
    if (!deps.memory) {
      reply.code(503);
      return { error: "memória desligada (memory.enabled: false)" };
    }
    return deps.memory.ingestProject(id, project.repoPath);
  });

  app.delete("/projects/:id/memories/:memoryId", async (request, reply) => {
    const { id, memoryId } = request.params as { id: string; memoryId: string };
    if (!deps.memory) {
      reply.code(503);
      return { error: "memória desligada (memory.enabled: false)" };
    }
    const removed = await deps.memory.remove(id, memoryId);
    if (!removed) reply.code(404);
    return { removed };
  });
}
