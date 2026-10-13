import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ProjectConfigSchema, loadConfig, loadRoleRegistry } from "@apo/config";
import { emitEvent } from "@apo/observability";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

// A validação do repo acontece aqui, no disco do daemon: com a CLI remota
// (Mac → VM), o caminho só existe na máquina do daemon.
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const createProjectSchema = z.object({
  // O nome é como `--project <nome>` encontra o Project: sem espaços, e nunca
  // parecido com um id (a CLI trataria como UUID).
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "use só letras, números, ponto, hífen e sublinhado")
    .refine((value) => !UUID_LIKE.test(value), "o nome não pode parecer um id (UUID)")
    .optional(),
  repoPath: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  configSnapshot: z.record(z.string(), z.unknown()).optional(),
});

/** Branch padrão do remoto (origin/HEAD); sem remoto, a branch atual. */
async function detectDefaultBranch(repoPath: string): Promise<string> {
  const remote = await execa("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: repoPath,
    reject: false,
  });
  if (remote.exitCode === 0 && remote.stdout.trim()) {
    return remote.stdout.trim().replace(/^origin\//, "");
  }
  const current = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    reject: false,
  });
  return current.exitCode === 0 && current.stdout.trim() !== "HEAD"
    ? current.stdout.trim()
    : "main";
}

const memorySchema = z.object({
  kind: z.enum(["convention", "decision", "pattern", "failure", "correction"]),
  title: z.string().min(1),
  content: z.string().min(1),
});

export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/projects", async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    if (!isAbsolute(body.repoPath) || !existsSync(join(body.repoPath, ".git"))) {
      reply.code(400);
      return { error: `${body.repoPath} não é um repositório git nesta máquina (a do daemon)` };
    }
    // Idempotente: registrar o mesmo caminho de novo devolve o existente.
    const existing = await deps.projects.getByRepoPath(body.repoPath);
    if (existing) {
      reply.code(200);
      return { ...existing, existing: true };
    }
    // Nome único (sem diferenciar maiúsculas): é a referência de `--project <nome>`.
    const name = body.name ?? basename(body.repoPath);
    const sameName = (await deps.projects.list()).find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );
    if (sameName) {
      reply.code(409);
      return {
        error: `já existe o Project "${sameName.name}" (${sameName.repoPath}); registre este com outro nome: apo project add <caminho> --name <nome>`,
      };
    }
    const configSnapshot =
      body.configSnapshot ??
      loadConfig(join(body.repoPath, ".apo", "project.yaml"), ProjectConfigSchema);
    const defaultBranch = body.defaultBranch ?? (await detectDefaultBranch(body.repoPath));
    const project = await deps.projects.create({
      id: randomUUID(),
      name,
      repoPath: body.repoPath,
      defaultBranch,
      configSnapshot,
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
