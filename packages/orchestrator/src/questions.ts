// M7 — perguntas dos workers ao humano (com o Lead como delegado).
//
// O worker não consegue esperar no meio da sessão (CLI não interativo): ele
// encerra o turno com `question` no WorkerReport. A pergunta vira uma
// `agent_messages` (type "question"); conforme o modo, quem responde é o
// usuário, o Lead, ou o Lead primeiro. A resposta é consumida pelo task-runner,
// que retoma a mesma sessão do agente.

import { randomUUID } from "node:crypto";
import type {
  AgentMessageRepository,
  EventRepository,
  SettingsRepository,
  TaskRepository,
} from "@apo/db";
import { type Logger, emitEvent } from "@apo/observability";
import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";
import type { MemoryPort } from "./memory-writer.js";
import { loadProjectConfig } from "./verify.js";

export const QUESTION = "question";
export const QUESTION_MODES = ["ask_human", "lead_first", "auto"] as const;
export type QuestionMode = (typeof QUESTION_MODES)[number];
/** Chave do modo global em `settings` (`apo questions auto on|off`). */
export const GLOBAL_QUESTION_MODE_KEY = "questions.mode";
/** `lead_first`: abaixo disso, a pergunta vai para o humano. */
export const LEAD_FIRST_MIN_CONFIDENCE = 0.75;

export const WorkerQuestionSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .max(6)
    .default([]),
  recommended: z.string().optional(),
  context: z.string().optional(),
});
export type WorkerQuestion = z.infer<typeof WorkerQuestionSchema>;

export interface QuestionPayload extends WorkerQuestion {
  taskId: string;
  taskTitle: string;
  role: string;
  attemptId: string;
  targetId: string;
  sessionId?: string | undefined;
}

export type ResolutionReason = "human" | "delegated" | "auto" | "lead_first" | "timeout" | "limit";

export interface QuestionResolution {
  answer: string;
  optionId?: string | undefined;
  answeredBy: "human" | "lead";
  reason: ResolutionReason;
  rationale?: string | undefined;
  confidence?: number | undefined;
  /** O task-runner já retomou o worker com esta resposta. */
  consumed?: boolean;
}

const ANSWERED_STATUSES = ["answered", "delegated", "auto"] as const;

function statusFor(reason: ResolutionReason): (typeof ANSWERED_STATUSES)[number] {
  if (reason === "human") return "answered";
  if (reason === "delegated") return "delegated";
  return "auto";
}

export interface QuestionDeps {
  agentMessages: AgentMessageRepository;
  tasks: TaskRepository;
  events: EventRepository;
  logger: Logger;
  settings?: SettingsRepository | undefined;
  memory?: MemoryPort | undefined;
}

/** Feature → global (runtime) → Project → padrão `ask_human`. */
export async function effectiveQuestionMode(
  deps: { settings?: SettingsRepository | undefined },
  feature: { questionMode?: string | null },
  repoPath: string,
): Promise<QuestionMode> {
  const valid = (mode: unknown): mode is QuestionMode =>
    typeof mode === "string" && (QUESTION_MODES as readonly string[]).includes(mode);
  if (valid(feature.questionMode)) return feature.questionMode;
  const global = await deps.settings?.get<string>(GLOBAL_QUESTION_MODE_KEY);
  if (valid(global)) return global;
  const project = loadProjectConfig(repoPath).questions?.mode;
  return valid(project) ? project : "ask_human";
}

export function questionLimits(repoPath: string): {
  maxPerTask: number;
  timeoutHours?: number | undefined;
} {
  const config = loadProjectConfig(repoPath).questions;
  return { maxPerTask: config?.maxPerTask ?? 2, timeoutHours: config?.timeoutHours };
}

const LeadAnswerSchema = z.object({
  optionId: z.string().optional(),
  answer: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

/** O Lead decide no lugar do usuário, com motivo e confiança. */
export async function decideWithLead(
  runner: AgentRunner,
  input: {
    objective: string;
    payload: QuestionPayload;
    cwd: string;
    timeoutMs: number;
    /** Decisões já tomadas nesta Feature — a nova não pode contradizê-las. */
    previousDecisions?: Array<{ question: string; answer: string }>;
  },
  signal: AbortSignal,
) {
  const { payload } = input;
  const options =
    payload.options.length > 0
      ? payload.options
          .map(
            (option) =>
              `- ${option.id}) ${option.label}${option.description ? ` — ${option.description}` : ""}`,
          )
          .join("\n")
      : "(sem opções: responda em texto livre)";
  const result = await runner.run(
    "lead",
    {
      prompt: [
        "Um worker parou para perguntar algo que não é dele decidir. O usuário não está disponível ou delegou",
        "a decisão a você: ele pediu que você DECIDA. Decida como o usuário decidiria: siga o objetivo, os",
        "requisitos e as convenções do projeto (leia o repositório se precisar). Prefira a opção recomendada pelo",
        "worker quando for razoável.",
        "Regras: (1) escolha um caminho CONCRETO que deixe a Feature funcionando — nunca 'ainda não decidido',",
        "'adiar' ou 'remover até o produto decidir' quando existir uma opção concreta razoável; prefira o padrão",
        "mais comum e fácil de mudar depois, e diga na resposta que é um padrão ajustável. (2) Seja coerente com",
        "as decisões já tomadas nesta Feature (abaixo): não as contradiga nem as desfaça.",
        "Se houver opções, devolva o `optionId` escolhido e repita a escolha em `answer`. `confidence` é sua",
        "confiança de que o usuário escolheria o mesmo (0 a 1).",
        input.previousDecisions && input.previousDecisions.length > 0
          ? `Decisões já tomadas nesta Feature:\n${input.previousDecisions
              .map((decision) => `- ${decision.question} → ${decision.answer}`)
              .join("\n")}`
          : "",
        `Objetivo da Feature: ${input.objective}`,
        `Task: ${payload.taskTitle} (${payload.role})`,
        `Pergunta: ${payload.question}`,
        `Opções:\n${options}`,
        payload.recommended ? `Recomendação do worker: ${payload.recommended}` : "",
        payload.context ? `Contexto do worker: ${payload.context}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      cwd: input.cwd,
      schema: LeadAnswerSchema,
      timeoutMs: input.timeoutMs,
    },
    signal,
  );
  return result.outcome === "success" ? result.output : undefined;
}

/** Interpreta a resposta humana: "b" → a opção b; texto livre fica como está. */
export function interpretHumanAnswer(
  payload: QuestionPayload,
  raw: string,
): { answer: string; optionId?: string } {
  const text = raw.trim();
  const option = payload.options.find(
    (candidate) => candidate.id.toLowerCase() === text.toLowerCase(),
  );
  if (option) {
    return {
      answer: `${option.id}) ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      optionId: option.id,
    };
  }
  return { answer: text };
}

export async function askQuestion(
  deps: Pick<QuestionDeps, "agentMessages" | "events" | "logger">,
  input: { featureId: string; projectId: string; payload: QuestionPayload },
) {
  const row = await deps.agentMessages.create({
    id: randomUUID(),
    featureId: input.featureId,
    fromTaskId: input.payload.taskId,
    type: QUESTION,
    payload: input.payload,
  });
  await emitEvent(deps.events, deps.logger, {
    type: "task.question",
    projectId: input.projectId,
    featureId: input.featureId,
    taskId: input.payload.taskId,
    payload: {
      questionId: row?.id,
      task: input.payload.taskTitle,
      role: input.payload.role,
      question: input.payload.question,
      options: input.payload.options,
      recommended: input.payload.recommended,
    },
  });
  return row;
}

/**
 * Registra a resposta (atômico: só a primeira vence) e devolve a Task para a
 * fila. A decisão vira memória do Project.
 */
export async function answerQuestion(
  deps: QuestionDeps,
  input: { questionId: string; projectId: string; resolution: QuestionResolution },
): Promise<boolean> {
  const row = await deps.agentMessages.resolveIf(
    input.questionId,
    "pending",
    statusFor(input.resolution.reason),
    input.resolution,
  );
  if (!row) return false;
  const payload = row.payload as QuestionPayload;
  await deps.tasks.transitionIf(payload.taskId, ["awaiting_answer"], "ready");
  await emitEvent(deps.events, deps.logger, {
    type: "task.question_answered",
    projectId: input.projectId,
    featureId: row.featureId,
    taskId: payload.taskId,
    payload: {
      questionId: row.id,
      question: payload.question,
      answer: input.resolution.answer,
      answeredBy: input.resolution.answeredBy,
      reason: input.resolution.reason,
      ...(input.resolution.rationale ? { rationale: input.resolution.rationale } : {}),
    },
  });
  if (deps.memory) {
    await deps.memory
      .remember(input.projectId, `question:${row.id}`, [
        {
          kind: "decision",
          title: payload.question.slice(0, 120),
          content: [
            `Pergunta (${payload.taskTitle}): ${payload.question}`,
            `Decisão${input.resolution.answeredBy === "lead" ? " (Lead do APO)" : " (usuário)"}: ${input.resolution.answer}`,
            ...(input.resolution.rationale ? [`Motivo: ${input.resolution.rationale}`] : []),
          ].join("\n"),
        },
      ])
      .catch((error: unknown) =>
        deps.logger.warn({ error }, "memória: falha ao registrar decisão"),
      );
  }
  return true;
}

/** Resposta ainda não usada para retomar o worker, se houver. */
export async function pendingAnswerFor(deps: Pick<QuestionDeps, "agentMessages">, taskId: string) {
  const rows = await deps.agentMessages.listByTask(taskId, QUESTION);
  const row = [...rows]
    .reverse()
    .find(
      (candidate) =>
        (ANSWERED_STATUSES as readonly string[]).includes(candidate.status) &&
        !(candidate.resolution as QuestionResolution | null)?.consumed,
    );
  if (!row) return undefined;
  return {
    id: row.id,
    status: row.status,
    payload: row.payload as QuestionPayload,
    resolution: row.resolution as QuestionResolution,
  };
}

export async function markAnswerConsumed(
  deps: Pick<QuestionDeps, "agentMessages">,
  questionId: string,
) {
  const row = await deps.agentMessages.getById(questionId);
  if (!row) return;
  await deps.agentMessages.resolveIf(questionId, row.status, row.status, {
    ...(row.resolution as QuestionResolution),
    consumed: true,
  });
}

export async function questionsAskedBy(
  deps: Pick<QuestionDeps, "agentMessages">,
  taskId: string,
): Promise<number> {
  return (await deps.agentMessages.listByTask(taskId, QUESTION)).length;
}

/** Decide pelo Lead e registra; false se o Lead não respondeu. */
export async function resolveWithLead(
  deps: QuestionDeps,
  input: {
    questionId: string;
    projectId: string;
    objective: string;
    payload: QuestionPayload;
    reason: Exclude<ResolutionReason, "human">;
    runner: AgentRunner;
    cwd: string;
    timeoutMs: number;
    minConfidence?: number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const current = await deps.agentMessages.getById(input.questionId);
  const previousDecisions = current
    ? (await deps.agentMessages.listByFeature(current.featureId))
        .filter(
          (message) =>
            message.type === QUESTION && message.id !== input.questionId && message.resolution,
        )
        .map((message) => ({
          question: (message.payload as QuestionPayload).question,
          answer: (message.resolution as QuestionResolution).answer,
        }))
    : [];
  const decision = await decideWithLead(
    input.runner,
    {
      objective: input.objective,
      payload: input.payload,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      previousDecisions,
    },
    signal,
  );
  if (!decision) return false;
  if (input.minConfidence !== undefined && decision.confidence < input.minConfidence) return false;
  return answerQuestion(deps, {
    questionId: input.questionId,
    projectId: input.projectId,
    resolution: {
      answer: decision.answer,
      ...(decision.optionId ? { optionId: decision.optionId } : {}),
      answeredBy: "lead",
      reason: input.reason,
      rationale: decision.rationale,
      confidence: decision.confidence,
    },
  });
}
