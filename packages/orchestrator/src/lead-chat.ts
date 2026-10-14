// Lead conversacional (M6.1–M6.3). O LLM só PROPÕE uma ação estruturada; quem
// muda estado é o daemon, de forma determinística, pelas mesmas rotas que a
// CLI usa. Schema plano (action + campos opcionais) para funcionar igual no
// Claude Code e no modo strict do Codex.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export const LEAD_ACTIONS = [
  "answer",
  "create_feature",
  "update_requirement",
  "replan",
  "set_preference",
  "cancel_task",
  "cancel_feature",
  "approve_feature",
  "reject_feature",
  "explain_routing",
  "answer_question",
  "delegate_question",
  "set_question_mode",
] as const;

export const LeadActionSchema = z.object({
  action: z.enum(LEAD_ACTIONS),
  /** O que dizer ao usuário, em português, junto com a ação. */
  reply: z.string().min(1),
  featureId: z.string().optional(),
  taskId: z.string().optional(),
  objective: z.string().optional(),
  intent: z.enum(["feature", "bugfix", "document"]).optional(),
  change: z.string().optional(),
  reason: z.string().optional(),
  preferenceMode: z.enum(["auto", "preferred", "forced"]).optional(),
  provider: z.enum(["anthropic", "openai", "google"]).optional(),
  harness: z.string().optional(),
  onOverlap: z.enum(["isolate", "absorb"]).optional(),
  /** M7: resposta a uma pergunta de worker (opção como "b" ou texto livre). */
  answer: z.string().optional(),
  /** M7: modo das perguntas; "inherit" volta ao padrão (desliga o global ou o da Feature). */
  questionMode: z.enum(["ask_human", "lead_first", "auto", "inherit"]).optional(),
});
export type LeadAction = z.infer<typeof LeadActionSchema>;

export interface ChatContext {
  projectName: string;
  features: Array<{
    id: string;
    objective: string;
    status: string;
    prUrl?: string | null;
    tasks?: Array<{ id: string; seq: number; title: string; status: string }>;
  }>;
  targets: Array<{ targetId: string; provider: string; harness: string }>;
  /** M7: perguntas de workers esperando resposta. */
  pendingQuestions?: Array<{
    taskId: string;
    taskTitle: string;
    role: string;
    question: string;
    options: Array<{ id: string; label: string }>;
    recommended?: string | undefined;
  }>;
  questionModeGlobal?: string | null;
  summary?: string | null;
  history: Array<{ role: string; content: string }>;
}

function renderContext(context: ChatContext): string {
  const features =
    context.features.length === 0
      ? "(nenhuma)"
      : context.features
          .map((feature) => {
            const head = `- ${feature.id} [${feature.status}] ${feature.objective}${feature.prUrl ? ` (PR: ${feature.prUrl})` : ""}`;
            const tasks = (feature.tasks ?? [])
              .map((task) => `    - task ${task.id} #${task.seq} [${task.status}] ${task.title}`)
              .join("\n");
            return tasks ? `${head}\n${tasks}` : head;
          })
          .join("\n");
  const history = context.history.map(
    (message) => `${message.role === "user" ? "Usuário" : "Lead"}: ${message.content}`,
  );
  return [
    `Project: ${context.projectName}`,
    `Features (mais recentes primeiro):\n${features}`,
    ...(context.pendingQuestions && context.pendingQuestions.length > 0
      ? [
          `Perguntas de workers esperando resposta:\n${context.pendingQuestions
            .map(
              (question) =>
                `- task ${question.taskId} (${question.taskTitle}, ${question.role}): ${question.question} ${question.options
                  .map((option) => `[${option.id}) ${option.label}]`)
                  .join(
                    " ",
                  )}${question.recommended ? ` (recomendado: ${question.recommended})` : ""}`,
            )
            .join("\n")}`,
        ]
      : []),
    `Modo global das perguntas: ${context.questionModeGlobal ?? "padrão do projeto (ask_human)"}`,
    `Targets de execução: ${context.targets.map((target) => `${target.targetId} (${target.provider}/${target.harness})`).join(", ")}`,
    context.summary ? `Resumo da conversa anterior:\n${context.summary}` : "",
    history.length > 0 ? `Conversa recente:\n${history.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const LEAD_CHAT_INSTRUCTIONS = [
  "Você conversa com o usuário sobre o desenvolvimento deste projeto. Responda com UMA ação:",
  "- answer: responder, explicar ou pedir esclarecimento (sem mudar nada). Use para perguntas sobre o código, o estado das Features ou quando o pedido for ambíguo.",
  "- create_feature: começar trabalho novo. `objective` autossuficiente (o worker não vê esta conversa); `intent` feature, bugfix ou document (o produto é um plano/análise/relatório, sem mudar código: sem gates nem correções automáticas). Se o daemon avisou de sobreposição com uma Feature ativa e o usuário escolheu, repita com `onOverlap` isolate ou absorb.",
  "- update_requirement: o usuário mudou/acrescentou um requisito de uma Feature existente (`featureId`, `change` autossuficiente). Em execução, o daemon cancela o que não começou e replaneja; esperando aprovação, vira um ajuste.",
  "- replan: replanejar o restante de uma Feature sem mudar requisito (`featureId`, `reason`).",
  "- set_preference: onde executar. Sem `taskId` vale para a Feature; com `taskId`, troca o target da Task agora. `preferenceMode` auto|preferred|forced e `provider` ou `harness`.",
  "- cancel_task: cancelar uma Task que ainda não começou (`taskId`).",
  "- cancel_feature: cancelar uma Feature inteira (`featureId`).",
  "- approve_feature: o usuário aprovou abrir o PR de uma Feature em awaiting_approval (`featureId`).",
  "- reject_feature: o usuário pediu ajustes numa Feature em awaiting_approval (`featureId`, `reason` com o que mudar).",
  "- explain_routing: explicar por que uma Task rodou onde rodou (`taskId`).",
  '- answer_question: o usuário respondeu a pergunta de um worker (`taskId`, `answer` com a opção, ex. "b", ou texto livre).',
  '- delegate_question: o usuário disse "decida você" para a pergunta de um worker (`taskId`); o Lead do APO decide e registra o motivo.',
  '- set_question_mode: mudar o modo das perguntas (`questionMode`: ask_human = perguntar ao usuário, lead_first = o Lead tenta antes, auto = o Lead decide tudo, inherit = voltar ao padrão). Com `featureId` vale só para a Feature; sem, é o modo global (ex.: "vou dormir, decide tudo" → auto; "voltei" → inherit).',
  "Regras: use só ids que aparecem no contexto. Nunca aprove, rejeite ou cancele sem o usuário ter pedido explicitamente. Na dúvida sobre qual Feature/Task, use answer e pergunte. `reply` é curto, em português, e diz o que vai acontecer.",
].join("\n");

export async function decideLeadAction(
  runner: AgentRunner,
  context: ChatContext,
  message: string,
  options: { cwd: string; timeoutMs: number },
  signal: AbortSignal,
) {
  return runner.run(
    "lead",
    {
      prompt: [
        LEAD_CHAT_INSTRUCTIONS,
        renderContext(context),
        `Mensagem do usuário: ${message}`,
      ].join("\n\n"),
      cwd: options.cwd,
      schema: LeadActionSchema,
      timeoutMs: options.timeoutMs,
    },
    signal,
  );
}

export const ThreadSummarySchema = z.object({ summary: z.string().min(1) });

/** M6.1 — resume a parte antiga da conversa, preservando decisões e pendências. */
export async function summarizeConversation(
  runner: AgentRunner,
  previousSummary: string | null | undefined,
  messages: Array<{ role: string; content: string }>,
  options: { cwd: string; timeoutMs: number },
  signal: AbortSignal,
) {
  const result = await runner.run(
    "lead",
    {
      prompt: [
        "Resuma esta conversa entre o usuário e o Lead em até 15 linhas, preservando decisões, preferências do usuário, ids de Features citadas e pendências. Descarte cumprimentos e repetições.",
        previousSummary ? `Resumo anterior:\n${previousSummary}` : "",
        messages
          .map((message) => `${message.role === "user" ? "Usuário" : "Lead"}: ${message.content}`)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      cwd: options.cwd,
      schema: ThreadSummarySchema,
      timeoutMs: options.timeoutMs,
    },
    signal,
  );
  return result.outcome === "success" ? result.output?.summary : undefined;
}
