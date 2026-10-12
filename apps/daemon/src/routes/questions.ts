// M7 — perguntas dos workers: listar, responder ("b", texto livre ou "decida
// você"), e os modos (global em runtime, por Feature).

import {
  DEFAULT_TASK_TIMEOUT_MS,
  GLOBAL_QUESTION_MODE_KEY,
  QUESTION,
  QUESTION_MODES,
  type QuestionPayload,
  answerQuestion,
  interpretHumanAnswer,
  pickJudge,
  resolveWithLead,
} from "@apo/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const answerSchema = z
  .object({ answer: z.string().min(1).optional(), delegate: z.boolean().optional() })
  .refine((body) => body.delegate === true || body.answer !== undefined, {
    message: "informe a resposta ou delegate: true",
  });
const modeSchema = z.object({ mode: z.enum(QUESTION_MODES).nullable() });

export type AnswerResult =
  | { ok: true; answeredBy: "human" | "lead"; answer: string }
  | { ok: false; error: string; status: number };

/** Usado pela rota e pelo `apo chat` (mesma regra nos dois caminhos). */
export async function answerTaskQuestion(
  deps: ServerDeps,
  taskId: string,
  input: { answer?: string | undefined; delegate?: boolean | undefined },
): Promise<AnswerResult> {
  const task = await deps.tasks.getById(taskId);
  if (!task) return { ok: false, status: 404, error: "task não encontrada" };
  const pending = (await deps.agentMessages.listByTask(taskId, QUESTION)).filter(
    (message) => message.status === "pending",
  );
  const question = pending.at(-1);
  if (!question)
    return { ok: false, status: 409, error: "essa Task não tem pergunta esperando resposta" };
  const feature = await deps.features.getById(task.featureId);
  const project = feature ? await deps.projects.getById(feature.projectId) : undefined;
  if (!feature || !project)
    return { ok: false, status: 404, error: "feature/project não encontrados" };
  const payload = question.payload as QuestionPayload;
  const questionDeps = {
    agentMessages: deps.agentMessages,
    tasks: deps.tasks,
    events: deps.events,
    logger: deps.logger,
    ...(deps.memoryPort ? { memory: deps.memoryPort } : {}),
  };

  if (input.delegate) {
    const judge = pickJudge(deps);
    if (!judge)
      return {
        ok: false,
        status: 503,
        error: "nenhum provider disponível para o Lead decidir agora",
      };
    const ok = await resolveWithLead(
      questionDeps,
      {
        questionId: question.id,
        projectId: project.id,
        objective: feature.objective,
        payload,
        reason: "delegated",
        runner: judge.runner,
        // A worktree da Task: é onde está o código que o worker escreveu até perguntar.
        cwd: task.worktreePath ?? project.repoPath,
        timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      },
      new AbortController().signal,
    );
    if (!ok)
      return { ok: false, status: 502, error: "o Lead não conseguiu decidir; responda você" };
    const decided = await deps.agentMessages.getById(question.id);
    return {
      ok: true,
      answeredBy: "lead",
      answer: (decided?.resolution as { answer?: string } | null)?.answer ?? "",
    };
  }

  const human = interpretHumanAnswer(payload, input.answer ?? "");
  const ok = await answerQuestion(questionDeps, {
    questionId: question.id,
    projectId: project.id,
    resolution: { ...human, answeredBy: "human", reason: "human" },
  });
  return ok
    ? { ok: true, answeredBy: "human", answer: human.answer }
    : { ok: false, status: 409, error: "a pergunta já foi respondida" };
}

export function registerQuestionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/questions", async (request) => {
    const { status } = request.query as { status?: string };
    const rows = await deps.agentMessages.listByStatus(QUESTION, status ?? "pending");
    return Promise.all(
      rows.map(async (row) => {
        const feature = await deps.features.getById(row.featureId);
        return {
          id: row.id,
          status: row.status,
          featureId: row.featureId,
          projectId: feature?.projectId,
          featureObjective: feature?.objective,
          createdAt: row.createdAt,
          resolution: row.resolution,
          ...(row.payload as QuestionPayload),
        };
      }),
    );
  });

  app.get("/features/:id/questions", async (request) => {
    const { id } = request.params as { id: string };
    return (await deps.agentMessages.listByFeature(id))
      .filter((row) => row.type === QUESTION)
      .map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        resolution: row.resolution,
        ...(row.payload as QuestionPayload),
      }));
  });

  app.post("/tasks/:id/answer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = answerSchema.parse(request.body);
    const result = await answerTaskQuestion(deps, id, body);
    if (!result.ok) {
      reply.code(result.status);
      return { error: result.error };
    }
    return result;
  });

  app.get("/settings/questions", async () => ({
    global: (await deps.settings.get<string>(GLOBAL_QUESTION_MODE_KEY)) ?? null,
  }));

  app.post("/settings/questions", async (request) => {
    const { mode } = modeSchema.parse(request.body);
    if (mode) await deps.settings.set(GLOBAL_QUESTION_MODE_KEY, mode);
    else await deps.settings.delete(GLOBAL_QUESTION_MODE_KEY);
    deps.logger.info({ mode }, "modo global das perguntas alterado");
    return { global: mode };
  });

  app.post("/features/:id/questions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { mode } = modeSchema.parse(request.body);
    const feature = await deps.features.update(id, { questionMode: mode });
    if (!feature) {
      reply.code(404);
      return { error: "feature não encontrada" };
    }
    return { featureId: id, mode };
  });
}
