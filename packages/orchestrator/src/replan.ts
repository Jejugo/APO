// Replan (M6.4). Mudança de requisito numa Feature em execução: cancela as
// Tasks que ainda não começaram e o Lead planeja só o que falta, sabendo o que
// já foi feito. Tasks em andamento ou concluídas não são tocadas.

import { emitEvent } from "@apo/observability";
import type { AgentRunResult, AgentRunner } from "./agent-runner.js";
import { appendTasks } from "./append-tasks.js";
import { type FeaturePlan, FeaturePlanSchema, validatePlan } from "./plan.js";
import type { EngineDeps } from "./task-runner.js";

const NOT_STARTED = new Set(["pending", "ready"]);

export interface ReplanInput {
  featureId: string;
  projectId: string;
  objective: string;
  change?: string;
  reason: string;
  roleIds: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ReplanResult {
  cancelled: string[];
  created: string[];
  source: "lead" | "fallback";
}

export async function replanFeature(
  deps: Pick<EngineDeps, "tasks" | "events" | "logger">,
  runner: AgentRunner,
  input: ReplanInput,
  signal: AbortSignal,
): Promise<ReplanResult> {
  if (input.change) {
    await emitEvent(deps.events, deps.logger, {
      type: "feature.requirement_updated",
      projectId: input.projectId,
      featureId: input.featureId,
      payload: { change: input.change },
    });
  }

  // Achado do E2E real do M6: cancelar antes de planejar deixava uma janela
  // (~20s, o Lead planejando) em que o graph via "tudo concluído ou cancelado"
  // e seguia para gates e review sem o trabalho replanejado. Agora: segurar →
  // planejar → anexar as novas → cancelar as seguradas.
  // Segura (`ready → pending`) o que não começou: o graph não roda Task
  // `pending` e espera o plano novo em vez de concluir sem ele.
  const tasks = await deps.tasks.listByFeature(input.featureId);
  const held: typeof tasks = [];
  for (const task of tasks) {
    if (!NOT_STARTED.has(task.status)) continue;
    const row = await deps.tasks.transitionIf(task.id, ["ready", "pending"], "pending");
    if (row) held.push(task);
  }
  const dropped = held;
  const kept = tasks.filter((task) => !held.some((candidate) => candidate.id === task.id));

  let result: AgentRunResult<FeaturePlan>;
  try {
    result = await runner.run(
      "lead",
      {
        prompt: [
          "Replaneje o restante desta Feature como um DAG de Tasks para workers de código.",
          "Planeje SÓ o trabalho que falta: o que está concluído ou em andamento já existe e não deve ser refeito.",
          `Roles válidos (use exatamente um destes ids em "role"): ${input.roleIds.join(", ")}.`,
          'Cada Task tem: key curta e única (t1, t2…), title, description autossuficiente, kind ("write"|"read"), role, expectedPaths e dependsOn (keys do NOVO plano apenas).',
          `Objetivo da Feature: ${input.objective}`,
          input.change
            ? `Mudança de requisito: ${input.change}`
            : `Motivo do replan: ${input.reason}`,
          `Concluídas ou em andamento:\n${kept.map((task) => `- [${task.status}] ${task.title}`).join("\n") || "- (nenhuma)"}`,
          `Serão canceladas (não começaram; reaproveite o que ainda fizer sentido):\n${dropped.map((task) => `- ${task.title}: ${task.description}`).join("\n") || "- (nenhuma)"}`,
        ].join("\n\n"),
        cwd: input.cwd,
        schema: FeaturePlanSchema,
        timeoutMs: input.timeoutMs,
      },
      signal,
    );
  } catch (error) {
    // Erro inesperado: solta as Tasks seguradas para a Feature não ficar parada.
    for (const task of held) await deps.tasks.transitionIf(task.id, ["pending"], "ready");
    throw error;
  }

  let plan: FeaturePlan;
  let source: ReplanResult["source"] = "lead";
  if (result.outcome === "success" && result.output && validatePlan(result.output).ok) {
    plan = result.output;
  } else {
    source = "fallback";
    plan = {
      tasks: [
        {
          key: "t1",
          title: (input.change ?? input.reason).slice(0, 120),
          description: [
            input.change ? `Aplique esta mudança de requisito: ${input.change}` : input.reason,
            dropped.length > 0
              ? `Inclua o que estas Tasks canceladas fariam: ${dropped.map((task) => task.title).join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          kind: "write",
          role: "generic",
          expectedPaths: [],
          dependsOn: [],
        },
      ],
    };
  }
  const created = await appendTasks(deps.tasks, input.featureId, plan, "replan");
  const cancelled: string[] = [];
  for (const task of dropped) {
    // Atômico: se o runner reivindicou a Task nesse meio-tempo, ela fica.
    const row = await deps.tasks.transitionIf(task.id, ["pending"], "cancelled");
    if (row) cancelled.push(task.id);
  }
  await emitEvent(deps.events, deps.logger, {
    type: "feature.replanned",
    projectId: input.projectId,
    featureId: input.featureId,
    payload: { reason: input.change ?? input.reason, cancelled, created, source },
  });
  return { cancelled, created, source };
}
