import { randomUUID } from "node:crypto";
import { loadRoleRegistry } from "@apo/config";
import type { ExecutionPreference } from "@apo/domain";
import { emitEvent } from "@apo/observability";
import {
  AgentRunnerImpl,
  DEFAULT_TASK_TIMEOUT_MS,
  type FeaturePlan,
  FeaturePlanSchema,
  appendTasks,
  candidatesOf,
  checkFeatureOverlap,
  findTarget,
  planFeature,
  triageIntent,
  validatePlan,
} from "@apo/orchestrator";
import { resolveExecutionTarget } from "@apo/routing";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const harnessSchema = z.enum(["claude-code", "codex", "gemini-cli", "antigravity", "fake"]);
const providerSchema = z.enum(["anthropic", "openai", "google"]);

// M3: `--harness` deixou de ser obrigatório. Sem preferência, o RuleBasedRouter
// escolhe por capacidade; `harness` = forced, `prefer` = preferred.
const createFeatureSchema = z.object({
  projectId: z.string().min(1),
  objective: z.string().min(1),
  as: z.enum(["question", "bugfix", "feature"]).optional(),
  harness: harnessSchema.optional(),
  prefer: harnessSchema.optional(),
  // M2.13: segunda chamada depois de um 409 `ask_user`. O cliente devolve o
  // plano recebido no 409 para não replanejar.
  onOverlap: z.enum(["isolate", "absorb"]).optional(),
  absorbInto: z.string().optional(),
  plan: FeaturePlanSchema.optional(),
});

const preferenceSchema = z.object({
  mode: z.enum(["forced", "preferred", "auto"]),
  harness: harnessSchema.optional(),
  provider: providerSchema.optional(),
});

const answerSchema = z.object({ answer: z.string() });

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "paused_capacity",
  "needs_human",
]);

function preferenceFrom(body: { harness?: string | undefined; prefer?: string | undefined }) {
  if (body.harness) return { mode: "forced", harness: body.harness } as ExecutionPreference;
  if (body.prefer) return { mode: "preferred", harness: body.prefer } as ExecutionPreference;
  return undefined;
}

interface ProjectRef {
  id: string;
  repoPath: string;
  defaultBranch: string;
}

interface FeatureRef {
  id: string;
  objective: string;
  plan?: unknown;
}

export function registerFeatureRoutes(app: FastifyInstance, deps: ServerDeps): void {
  function startRun(project: ProjectRef, feature: FeatureRef, label: string): void {
    void deps.featureRunner
      .run({
        featureId: feature.id,
        projectId: project.id,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        objective: feature.objective,
        worktreesRoot: deps.worktreesRoot,
      })
      .catch((error: unknown) => {
        deps.logger.error({ error, featureId: feature.id }, `${label} falhou`);
      });
  }

  /** expectedPaths de uma Feature ativa: das Tasks, ou do plano se ainda não há Tasks. */
  async function footprintOf(feature: FeatureRef) {
    const tasks = await deps.tasks.listByFeature(feature.id);
    const parsed = FeaturePlanSchema.safeParse(feature.plan);
    const paths =
      tasks.length > 0
        ? tasks.flatMap((task) => task.expectedPaths ?? [])
        : parsed.success
          ? parsed.data.tasks.flatMap((task) => task.expectedPaths)
          : [];
    return { featureId: feature.id, objective: feature.objective, expectedPaths: paths };
  }

  app.post("/features", async (request, reply) => {
    const body = createFeatureSchema.parse(request.body);
    const project = await deps.projects.getById(body.projectId);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }

    const preference = preferenceFrom(body);

    // O Lead (IntentTriage e perguntas) também é roteado por capacidade:
    // com o Codex esgotado, uma pergunta não deve falhar se o Claude Code estiver livre.
    // `--harness` (forced) diz onde o *worker* roda. Para o Lead, que só faz
    // julgamento (triage/pergunta), a escolha do usuário vale só como
    // preferência — senão um forced num provider esgotado barraria a criação
    // da Feature, em vez de ela ir para needs_human como o modo forced pede.
    const leadTarget = resolveExecutionTarget({
      // O Lead depende de saída estruturada; targets sem isso (agy) ficam de fora.
      candidates: candidatesOf(
        deps.targets.filter((entry) => entry.harness.getCapabilities().supportsOutputSchema),
      ),
      capacity: (provider) => deps.capacity.get(provider),
      featurePreference: preference ? { ...preference, mode: "preferred" } : null,
      policy: deps.routingPolicy,
    });
    if (leadTarget.kind !== "target") {
      reply.code(503);
      return { error: "nenhum provider disponível para o Lead agora", reason: leadTarget.reason };
    }
    const leadEntry = findTarget(deps.targets, leadTarget.target.targetId);
    if (!leadEntry) {
      reply.code(500);
      return { error: "target do Lead sem harness registrado" };
    }
    const agentRunner = new AgentRunnerImpl(leadEntry.harness);
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
          prompt: `Responda à pergunta do usuário usando leitura do repositório em ${project.repoPath}. Pergunta: "${body.objective}"`,
          cwd: project.repoPath,
          schema: answerSchema,
          timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
        },
        controller.signal,
      );

      if (result.outcome !== "success" || !result.output) {
        if (result.failure) {
          deps.capacity.recordFailure(leadEntry.harness.provider, result.failure);
        }
        reply.code(502);
        return { error: "Lead não conseguiu responder", failure: result.failure };
      }

      await emitEvent(deps.events, deps.logger, {
        type: "query.answered",
        projectId: project.id,
        payload: {
          objective: body.objective,
          answer: result.output.answer,
          target: leadEntry.candidate.targetId,
        },
      });

      return { intent: "question" as const, answer: result.output.answer };
    }

    const intent = triage.intent;

    // M2.5: o Lead planeja o DAG antes de a Feature existir — os expectedPaths
    // do plano alimentam o FeatureOverlapCheck.
    let plan: FeaturePlan;
    let planFallbackReason: string | undefined;
    if (body.plan && validatePlan(body.plan).ok) {
      plan = body.plan;
    } else {
      const planned = await planFeature(
        agentRunner,
        {
          objective: body.objective,
          intent,
          roleIds: [...loadRoleRegistry(project.repoPath).keys()],
          cwd: project.repoPath,
          timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
        },
        controller.signal,
      );
      plan = planned.plan;
      planFallbackReason = planned.reason;
    }

    // M2.12/M2.13: sobreposição com Feature ativa → pergunta ao usuário (409).
    // `--on-overlap absorb` sem alvo (CLI não interativa) também precisa da
    // verificação, para descobrir em qual Feature absorver.
    let absorbInto = body.absorbInto;
    if (body.onOverlap === undefined || (body.onOverlap === "absorb" && !absorbInto)) {
      const active = await deps.features.listActiveByProject(project.id);
      const overlap = await checkFeatureOverlap(
        {
          objective: body.objective,
          expectedPaths: plan.tasks.flatMap((task) => task.expectedPaths),
          active: await Promise.all(active.map(footprintOf)),
          runner: agentRunner,
          cwd: project.repoPath,
          timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
        },
        controller.signal,
      );
      if (overlap.decision === "ask_user") {
        if (body.onOverlap === undefined) {
          reply.code(409);
          return { ...overlap, intent, plan };
        }
        absorbInto = overlap.overlappingFeatureId;
      }
    }

    // Absorver sem nenhuma Feature sobreposta cai no fluxo normal (Feature nova).
    if (body.onOverlap === "absorb" && absorbInto) {
      const target = await deps.features.getById(absorbInto);
      const stillActive =
        target &&
        (await deps.features.listActiveByProject(project.id)).some((f) => f.id === target.id);
      if (!target || !stillActive) {
        reply.code(409);
        return {
          error:
            "a Feature a absorver o pedido não está mais ativa; rode de novo para criar uma Feature nova",
        };
      }
      const taskIds = await appendTasks(
        deps.tasks,
        target.id,
        {
          tasks: plan.tasks.map((task) => ({
            ...task,
            description: `Pedido original (absorvido nesta Feature): ${body.objective}\n\n${task.description}`,
          })),
        },
        "overlap_absorbed",
      );
      await emitEvent(deps.events, deps.logger, {
        type: "feature.request_absorbed",
        projectId: project.id,
        featureId: target.id,
        payload: { originalObjective: body.objective, intoFeatureId: target.id, taskIds },
      });
      if (!deps.featureRunner.isRunning(target.id)) {
        startRun(project, target, "feature run (absorção)");
      }
      return { absorbedInto: target.id, taskIds };
    }

    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: body.objective,
      intent,
      plan,
      ...(preference ? { executionPreference: preference } : {}),
    });
    if (!feature) {
      reply.code(500);
      return { error: "falha ao criar feature" };
    }
    if (planFallbackReason) {
      await emitEvent(deps.events, deps.logger, {
        type: "feature.plan_fallback",
        projectId: project.id,
        featureId: feature.id,
        payload: { reason: planFallbackReason },
      });
    }

    startRun(project, feature, "feature run");

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

  // M3.10 — `apo feature preference`. Vale para o próximo attempt (não
  // interrompe o atual; para isso existe `apo task reroute`).
  app.post("/features/:id/preference", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = preferenceSchema.parse(request.body);
    if (body.mode !== "auto" && !body.harness && !body.provider) {
      reply.code(400);
      return { error: "modo forced/preferred precisa de harness ou provider" };
    }
    const preference: ExecutionPreference | null =
      body.mode === "auto"
        ? null
        : {
            mode: body.mode,
            ...(body.harness ? { harness: body.harness } : {}),
            ...(body.provider ? { provider: body.provider } : {}),
          };
    const feature = await deps.features.updateExecutionPreference(id, preference);
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    await emitEvent(deps.events, deps.logger, {
      type: "feature.preference_changed",
      featureId: id,
      payload: { preference },
    });
    return feature;
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

    await deps.features.updateStatus(id, "executing");
    await emitEvent(deps.events, deps.logger, { type: "feature.resumed", featureId: id });

    if (!deps.featureRunner.isRunning(id)) {
      startRun(project, feature, "feature resume");
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
    // Só sinaliza o AttemptControl — quem escreve o status terminal
    // ("cancelled") é sempre o node 'complete' do graph, nunca esta rota.
    const wasRunning = deps.featureRunner.cancel(id);
    await emitEvent(deps.events, deps.logger, { type: "feature.cancel_requested", featureId: id });
    return { ...feature, cancelRequested: true, wasRunning };
  });
}
