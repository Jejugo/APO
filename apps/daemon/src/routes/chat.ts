// M6.1–M6.4 — `apo chat`. O Lead propõe UMA ação estruturada por mensagem; o
// daemon valida (ids pertencem ao Project, estado permite) e executa pelas
// mesmas rotas HTTP que a CLI usa (`app.inject`). O LLM nunca muda estado
// diretamente.

import { randomUUID } from "node:crypto";
import { loadRoleRegistry } from "@apo/config";
import { emitEvent } from "@apo/observability";
import {
  DEFAULT_TASK_TIMEOUT_MS,
  type LeadAction,
  decideLeadAction,
  pickJudge,
  replanFeature,
  summarizeConversation,
} from "@apo/orchestrator";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerDeps } from "../server-deps.js";

const chatSchema = z.object({ message: z.string().min(1) });

/** Mensagens que ficam literais no prompt; o resto vira resumo (M6.1). */
const RECENT_MESSAGES = 12;
const SUMMARIZE_AFTER = 40;
const JUDGE_TIMEOUT_MS = 10 * 60_000;
const RUNNING_STATUSES = new Set([
  "planning",
  "executing",
  "integrating",
  "validating",
  "reviewing",
  "fixing",
  "paused_capacity",
]);

export interface ActionResult {
  ok: boolean;
  /** Texto determinístico do que o daemon fez (ou por que não fez). */
  note: string;
  data?: unknown;
}

export function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): void {
  async function call(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    const response = await app.inject(
      payload !== undefined ? { method, url, payload } : { method, url },
    );
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body: body as Record<string, unknown> };
  }

  async function featureOf(projectId: string, featureId: string | undefined) {
    if (!featureId) return undefined;
    const feature = await deps.features.getById(featureId);
    return feature && feature.projectId === projectId ? feature : undefined;
  }

  async function taskOf(projectId: string, taskId: string | undefined) {
    if (!taskId) return undefined;
    const task = await deps.tasks.getById(taskId);
    if (!task) return undefined;
    return (await featureOf(projectId, task.featureId)) ? task : undefined;
  }

  async function replan(
    project: { id: string; repoPath: string },
    feature: { id: string; objective: string; status: string },
    change: string | undefined,
    reason: string,
  ): Promise<ActionResult> {
    if (feature.status === "awaiting_approval") {
      const response = await call("POST", `/features/${feature.id}/reject`, {
        reason: change ?? reason,
      });
      return response.status < 300
        ? {
            ok: true,
            note: "A Feature esperava aprovação: o pedido virou um ajuste (reject com o motivo).",
          }
        : { ok: false, note: `não consegui registrar o ajuste: ${JSON.stringify(response.body)}` };
    }
    if (feature.status === "completed" || feature.status === "cancelled") {
      return {
        ok: false,
        note: `a Feature já está ${feature.status}; para mudar algo, crie uma Feature nova.`,
      };
    }
    const judge = pickJudge(deps);
    if (!judge)
      return { ok: false, note: "nenhum provider disponível para o Lead replanejar agora." };
    const result = await replanFeature(
      deps,
      judge.runner,
      {
        featureId: feature.id,
        projectId: project.id,
        objective: feature.objective,
        ...(change ? { change } : {}),
        reason,
        roleIds: [...loadRoleRegistry(project.repoPath).keys()],
        cwd: project.repoPath,
        timeoutMs: JUDGE_TIMEOUT_MS,
      },
      new AbortController().signal,
    );
    // Parada (needs_human/failed/paused): retoma para as Tasks novas rodarem.
    if (!deps.featureRunner.isRunning(feature.id)) {
      await call("POST", `/features/${feature.id}/resume`);
    }
    return {
      ok: true,
      note: `Replanejado: ${result.cancelled.length} Task(s) que não tinham começado foram canceladas e ${result.created.length} nova(s) foram criadas.`,
      data: result,
    };
  }

  async function execute(
    project: { id: string; repoPath: string },
    action: LeadAction,
  ): Promise<ActionResult> {
    switch (action.action) {
      case "answer":
        return { ok: true, note: "" };

      case "create_feature": {
        if (!action.objective) return { ok: false, note: "faltou o objetivo da Feature." };
        const response = await call("POST", "/features", {
          projectId: project.id,
          objective: action.objective,
          ...(action.intent ? { as: action.intent } : {}),
          ...(action.onOverlap ? { onOverlap: action.onOverlap } : {}),
        });
        const body = response.body;
        if (response.status === 201) {
          return {
            ok: true,
            note: `Feature criada: ${body.id}. Planejamento em andamento.`,
            data: { featureId: body.id },
          };
        }
        if (response.status === 409 && body.decision === "ask_user") {
          return {
            ok: false,
            note: `Isso se sobrepõe à Feature ${body.overlappingFeatureId} ("${body.overlappingObjective}"), nos caminhos ${(body.sharedPaths as string[]).join(", ")}. Quer isolar numa Feature nova ou absorver na existente?`,
            data: body,
          };
        }
        if (body.absorbedInto) {
          return {
            ok: true,
            note: `Pedido absorvido pela Feature ${body.absorbedInto}.`,
            data: body,
          };
        }
        if (body.answer) return { ok: true, note: String(body.answer) };
        return { ok: false, note: `o daemon recusou: ${JSON.stringify(body).slice(0, 300)}` };
      }

      case "update_requirement":
      case "replan": {
        const feature = await featureOf(project.id, action.featureId);
        if (!feature) return { ok: false, note: "não encontrei essa Feature neste Project." };
        const change = action.action === "update_requirement" ? action.change : undefined;
        if (action.action === "update_requirement" && !change) {
          return { ok: false, note: "faltou descrever a mudança de requisito." };
        }
        return replan(project, feature, change, action.reason ?? change ?? "replan pedido no chat");
      }

      case "set_preference": {
        if (action.taskId) {
          const task = await taskOf(project.id, action.taskId);
          if (!task) return { ok: false, note: "não encontrei essa Task neste Project." };
          if (!action.provider && !action.harness)
            return { ok: false, note: "faltou o provider ou harness de destino." };
          const response = await call("POST", `/tasks/${task.id}/reroute`, {
            ...(action.harness ? { harness: action.harness } : {}),
            ...(action.provider ? { provider: action.provider } : {}),
          });
          return response.status < 300
            ? {
                ok: true,
                note: response.body.interrupted
                  ? "Attempt atual interrompido; a Task continua no novo target, com handover."
                  : "O novo target vale para o próximo attempt da Task.",
              }
            : {
                ok: false,
                note: `reroute recusado: ${JSON.stringify(response.body).slice(0, 300)}`,
              };
        }
        const feature = await featureOf(project.id, action.featureId);
        if (!feature) return { ok: false, note: "não encontrei essa Feature neste Project." };
        const response = await call("POST", `/features/${feature.id}/preference`, {
          mode: action.preferenceMode ?? "preferred",
          ...(action.harness ? { harness: action.harness } : {}),
          ...(action.provider ? { provider: action.provider } : {}),
        });
        return response.status < 300
          ? {
              ok: true,
              note: "Preferência de execução da Feature atualizada (vale a partir do próximo attempt).",
            }
          : {
              ok: false,
              note: `preferência recusada: ${JSON.stringify(response.body).slice(0, 300)}`,
            };
      }

      case "cancel_task": {
        const task = await taskOf(project.id, action.taskId);
        if (!task) return { ok: false, note: "não encontrei essa Task neste Project." };
        const row = await deps.tasks.transitionIf(task.id, ["pending", "ready"], "cancelled");
        return row
          ? { ok: true, note: `Task "${task.title}" cancelada.` }
          : {
              ok: false,
              note: `a Task "${task.title}" já começou (${task.status}); para parar o trabalho em andamento, cancele a Feature ou peça um replan.`,
            };
      }

      case "cancel_feature":
      case "approve_feature":
      case "reject_feature": {
        const feature = await featureOf(project.id, action.featureId);
        if (!feature) return { ok: false, note: "não encontrei essa Feature neste Project." };
        const verb = action.action.replace("_feature", "");
        if (verb === "reject" && !action.reason)
          return { ok: false, note: "faltou dizer o que ajustar." };
        const response = await call(
          "POST",
          `/features/${feature.id}/${verb}`,
          verb === "reject" ? { reason: action.reason as string } : undefined,
        );
        if (response.status >= 300) {
          return {
            ok: false,
            note: String(response.body.error ?? JSON.stringify(response.body)).slice(0, 300),
          };
        }
        const notes: Record<string, string> = {
          cancel: "Cancelamento pedido; o graph encerra a Feature.",
          approve: "Aprovada: o APO vai fazer push e abrir o PR.",
          reject: "Rejeitada: o motivo virou uma Task de ajuste.",
        };
        return { ok: true, note: notes[verb] ?? "" };
      }

      case "explain_routing": {
        const task = await taskOf(project.id, action.taskId);
        if (!task) return { ok: false, note: "não encontrei essa Task neste Project." };
        const decisions = (await deps.routingDecisions.listByTask(task.id)) as Array<{
          router: string;
          resolutionSource: string;
          finalTarget: { targetId?: string } | null;
          output: {
            reason?: string;
            semantic?: {
              complexity: string;
              risk: string;
              ranking: Array<{ targetId: string; probability: number }>;
            };
            overriddenByPolicy?: boolean;
            suggested?: string;
            semanticError?: string;
          } | null;
        }>;
        if (decisions.length === 0)
          return { ok: true, note: `A Task "${task.title}" ainda não foi roteada.` };
        const lines = decisions.map((decision, index) => {
          const semantic = decision.output?.semantic;
          return [
            `#${index + 1} → ${decision.finalTarget?.targetId ?? "—"} (${decision.resolutionSource}): ${decision.output?.reason ?? ""}`,
            semantic
              ? `   Jev: complexidade ${semantic.complexity}, risco ${semantic.risk}; ${semantic.ranking.map((entry) => `${entry.targetId}=${entry.probability.toFixed(2)}`).join(", ")}`
              : "",
            decision.output?.overriddenByPolicy
              ? `   a política de capacidade trocou a sugestão ${decision.output.suggested}`
              : "",
            decision.output?.semanticError
              ? `   Jev indisponível: ${decision.output.semanticError}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        });
        return { ok: true, note: lines.join("\n") };
      }
    }
  }

  async function maybeSummarize(
    thread: { id: string; summary: string | null; summarizedUntil: Date | null },
    cwd: string,
  ) {
    const pending = await deps.conversations.unsummarized(thread.id, thread.summarizedUntil);
    if (pending.length <= SUMMARIZE_AFTER) return;
    const old = pending.slice(0, pending.length - RECENT_MESSAGES);
    const judge = pickJudge(deps);
    const last = old.at(-1);
    if (!judge || !last) return;
    const summary = await summarizeConversation(
      judge.runner,
      thread.summary,
      old.map((message) => ({ role: message.role, content: message.content })),
      { cwd, timeoutMs: JUDGE_TIMEOUT_MS },
      new AbortController().signal,
    );
    if (summary) await deps.conversations.updateSummary(thread.id, summary, last.createdAt);
  }

  app.post("/projects/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { message } = chatSchema.parse(request.body);
    const project = await deps.projects.getById(id);
    if (!project) {
      reply.code(404);
      return { error: "project não encontrado" };
    }
    const thread = await deps.conversations.threadFor(project.id, randomUUID());
    const history = await deps.conversations.recent(thread.id, RECENT_MESSAGES);
    await deps.conversations.addMessage({
      id: randomUUID(),
      threadId: thread.id,
      role: "user",
      content: message,
    });

    const features = (await deps.features.listByProject(project.id))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 8);
    const context = {
      projectName: project.name,
      features: await Promise.all(
        features.map(async (feature) => ({
          id: feature.id,
          objective: feature.objective,
          status: feature.status,
          prUrl: feature.prUrl,
          ...(RUNNING_STATUSES.has(feature.status) ||
          feature.status === "awaiting_approval" ||
          feature.status === "needs_human"
            ? {
                tasks: (await deps.tasks.listByFeature(feature.id))
                  .sort((a, b) => a.seq - b.seq)
                  .map((task) => ({
                    id: task.id,
                    seq: task.seq,
                    title: task.title,
                    status: task.status,
                  })),
              }
            : {}),
        })),
      ),
      targets: deps.targets.map((entry) => ({
        targetId: entry.candidate.targetId,
        provider: entry.candidate.provider,
        harness: entry.candidate.harness,
      })),
      summary: thread.summary,
      history: history.map((row) => ({
        role: row.role,
        content:
          row.role === "lead" && row.result
            ? `${row.content}\n[resultado: ${(row.result as ActionResult).note}]`
            : row.content,
      })),
    };

    const judge = pickJudge(deps);
    if (!judge) {
      reply.code(503);
      return { error: "nenhum provider disponível para o Lead agora" };
    }
    const decided = await decideLeadAction(
      judge.runner,
      context,
      message,
      { cwd: project.repoPath, timeoutMs: DEFAULT_TASK_TIMEOUT_MS },
      new AbortController().signal,
    );
    if (decided.outcome !== "success" || !decided.output) {
      if (decided.failure)
        deps.capacity.recordFailure(judge.entry.harness.provider, decided.failure);
      reply.code(502);
      return { error: "o Lead não conseguiu responder", failure: decided.failure };
    }
    const action = decided.output;
    const result = await execute(project, action).catch(
      (error: unknown): ActionResult => ({
        ok: false,
        note: `erro ao executar: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    await deps.conversations.addMessage({
      id: randomUUID(),
      threadId: thread.id,
      role: "lead",
      content: action.reply,
      action,
      result,
    });
    await emitEvent(deps.events, deps.logger, {
      type: "chat.action",
      projectId: project.id,
      ...(action.featureId && (await featureOf(project.id, action.featureId))
        ? { featureId: action.featureId }
        : {}),
      payload: { action: action.action, ok: result.ok, target: judge.entry.candidate.targetId },
    });
    void maybeSummarize(thread, project.repoPath).catch((error: unknown) => {
      deps.logger.warn({ error }, "chat: falha ao resumir a conversa");
    });
    return { threadId: thread.id, reply: action.reply, action, result };
  });

  app.get("/projects/:id/chat", async (request) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };
    const thread = await deps.conversations.threadFor(id, randomUUID());
    return {
      threadId: thread.id,
      summary: thread.summary,
      messages: await deps.conversations.recent(thread.id, Number(limit ?? 20)),
    };
  });
}
