import { randomUUID } from "node:crypto";
import type { HarnessId } from "@apo/domain";
import { emitEvent } from "@apo/observability";
import {
  AgentRunnerImpl,
  DEFAULT_TASK_TIMEOUT_MS,
  resolveHarness,
  triageIntent,
} from "@apo/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const createFeatureSchema = z.object({
  projectId: z.string().min(1),
  objective: z.string().min(1),
  as: z.enum(["question", "bugfix", "feature"]).optional(),
  harness: z.enum(["claude-code", "codex", "gemini-cli", "fake"]),
});

const answerSchema = z.object({ answer: z.string() });

export function registerFeatureRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/features", async (request, reply) => {
    const body = createFeatureSchema.parse(request.body);
    const project = await deps.projects.getById(body.projectId);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }

    const harness = resolveHarness(deps.harnessRegistry, body.harness);
    const agentRunner = new AgentRunnerImpl(harness);
    const controller = new AbortController();

    const triage = await triageIntent(
      body.objective,
      {
        ...(body.as !== undefined ? { override: body.as } : {}),
        agentRunner,
        cwd: project.repoPath,
        timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      },
      controller.signal,
    );

    if (triage.intent === "question") {
      const result = await agentRunner.run(
        "lead",
        {
          prompt:
            `Responda à pergunta do usuário usando leitura do repositório em ${project.repoPath}. ` +
            `Pergunta: "${body.objective}"`,
          cwd: project.repoPath,
          schema: answerSchema,
          timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
        },
        controller.signal,
      );

      if (result.outcome !== "success" || !result.output) {
        reply.code(502);
        return { error: "Lead não conseguiu responder", failure: result.failure };
      }

      await emitEvent(deps.events, deps.logger, {
        type: "query.answered",
        projectId: project.id,
        payload: { objective: body.objective, answer: result.output.answer },
      });

      return { intent: "question" as const, answer: result.output.answer };
    }

    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: body.objective,
      intent: triage.intent,
      executionPreference: { mode: "forced", harness: body.harness },
    });
    if (!feature) {
      reply.code(500);
      return { error: "falha ao criar feature" };
    }

    void deps.featureRunner
      .run({
        featureId: feature.id,
        projectId: project.id,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        objective: body.objective,
        harness: body.harness,
        worktreesRoot: deps.worktreesRoot,
      })
      .catch((error: unknown) => {
        deps.logger.error({ error, featureId: feature.id }, "feature run falhou");
      });

    reply.code(201);
    return feature;
  });

  app.get("/features", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    if (!projectId) {
      return [];
    }
    return deps.features.listByProject(projectId);
  });

  app.get("/features/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const feature = await deps.features.getById(id);
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    return feature;
  });

  app.get("/features/:id/tasks", async (request) => {
    const { id } = request.params as { id: string };
    return deps.tasks.listByFeature(id);
  });

  app.post("/features/:id/pause", async (request, reply) => {
    const { id } = request.params as { id: string };
    const feature = await deps.features.updateStatus(id, "paused");
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    await emitEvent(deps.events, deps.logger, { type: "feature.paused", featureId: id });
    return feature;
  });

  app.post("/features/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const feature = await deps.features.getById(id);
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    const project = await deps.projects.getById(feature.projectId);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }

    const executionPreference = feature.executionPreference as
      | { harness?: HarnessId }
      | null
      | undefined;
    const harness = executionPreference?.harness;
    if (!harness) {
      reply.code(400);
      return { error: "sem harness anterior registrado para retomar esta feature" };
    }

    await deps.features.updateStatus(id, "executing");
    await emitEvent(deps.events, deps.logger, { type: "feature.resumed", featureId: id });

    if (!deps.featureRunner.isRunning(id)) {
      void deps.featureRunner
        .run({
          featureId: id,
          projectId: project.id,
          repoPath: project.repoPath,
          defaultBranch: project.defaultBranch,
          objective: feature.objective,
          harness,
          worktreesRoot: deps.worktreesRoot,
        })
        .catch((error: unknown) => {
          deps.logger.error({ error, featureId: id }, "feature resume falhou");
        });
    }

    return deps.features.getById(id);
  });

  // M1.12 — `apo logs <feature> [-f]`. Sem `follow`, devolve o que já
  // aconteceu. Com `follow=true`, SSE: manda o que já existe e faz polling
  // da tabela `events` (sem pub/sub — volume baixo o bastante para isso ser
  // proporcional, regra 12 do PLAN.md) até a Feature chegar a um estado
  // terminal ou o cliente desconectar.
  app.get("/features/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { follow } = request.query as { follow?: string };

    if (follow !== "true" && follow !== "1") {
      return deps.events.listByFeature(id);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let lastId: number | undefined;
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const initial = await deps.events.listByFeature(id);
    for (const row of initial) {
      reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
      lastId = row.id;
    }

    const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (closed) {
        break;
      }
      const newRows = await deps.events.listByFeature(id, lastId);
      for (const row of newRows) {
        reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
        lastId = row.id;
      }
      const feature = await deps.features.getById(id);
      if (feature && TERMINAL_STATUSES.has(feature.status)) {
        reply.raw.write("event: done\ndata: {}\n\n");
        break;
      }
    }
    reply.raw.end();
  });

  app.post("/features/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const feature = await deps.features.getById(id);
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    // Só sinaliza o AbortSignal — quem escreve o status terminal ("cancelled")
    // é sempre o node 'complete' do graph (feature-graph.ts), nunca esta rota:
    // escrever aqui também criaria uma corrida entre as duas escritas.
    const wasRunning = deps.featureRunner.cancel(id);
    await emitEvent(deps.events, deps.logger, { type: "feature.cancel_requested", featureId: id });
    return { ...feature, cancelRequested: true, wasRunning };
  });
}
