// ApoNativeEngine (ADR 0003): o graph de uma Feature.
//
//   triage → plan → execute_wave ⇄ (próxima onda) → verify → complete
//
// - plan (M2.5): usa o plano já gerado e validado na criação da Feature
//   (`features.plan`) ou cai para uma Task só. Cria a branch e a worktree de
//   integração.
// - execute_wave (M2.6/M2.7/M2.8): roda em paralelo as Tasks cujas
//   dependências já foram integradas, cada uma com failover próprio
//   (task-runner.ts), e então faz merge `--no-ff` das concluídas na integração,
//   em ordem. Conflito → `merge --abort` + Task corretiva anexada à Feature.
// - verify: worktree de integração (prepare + testes do project.yaml).
//
// Limitação aceita (TECHNICAL_PLAN.md, "barreira de onda"): uma Task da onda
// seguinte espera a onda inteira terminar, mesmo que dependa só de uma Task
// rápida. Determinístico e simples de testar; otimização fica para depois.
//
// Os nodes são idempotentes: recovery (M1.13) e saída de paused_capacity
// (M3.9) re-invocam o graph do zero.

import { emitEvent } from "@apo/observability";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { appendTasks } from "./append-tasks.js";
import type { AttemptControl } from "./attempt-control.js";
import { candidatesOf } from "./harness-registry.js";
import { FeaturePlanSchema, singleTaskPlan, validatePlan } from "./plan.js";
import {
  type EngineDeps,
  type FeatureContext,
  type TaskRunOutcome,
  runTask,
} from "./task-runner.js";
import { verifyIntegration } from "./verify.js";
import {
  ensureIntegrationWorktree,
  integrationBranchName,
  integrationWorktreePath,
  mergeIntoIntegration,
} from "./worktree.js";

export { DEFAULT_TASK_TIMEOUT_MS } from "./task-runner.js";

type Outcome =
  | "continue"
  | "integrated"
  | "success"
  | "failure"
  | "cancelled"
  | "paused_capacity"
  | "needs_human";

export const FeatureGraphState = Annotation.Root({
  featureId: Annotation<string>,
  projectId: Annotation<string>,
  repoPath: Annotation<string>,
  defaultBranch: Annotation<string>,
  objective: Annotation<string>,
  worktreesRoot: Annotation<string>,
  // `null` = reset explícito no triage (re-invocação reaproveita o checkpoint).
  outcome: Annotation<Outcome | null | undefined>,
  failureReason: Annotation<string | null | undefined>,
});

export type FeatureGraphInput = Pick<
  typeof FeatureGraphState.State,
  "featureId" | "projectId" | "repoPath" | "defaultBranch" | "objective" | "worktreesRoot"
>;

export type FeatureGraphDeps = EngineDeps;

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "needs_human"]);

function contextOf(state: typeof FeatureGraphState.State): FeatureContext {
  return {
    featureId: state.featureId,
    projectId: state.projectId,
    repoPath: state.repoPath,
    defaultBranch: state.defaultBranch,
    objective: state.objective,
    worktreesRoot: state.worktreesRoot,
  };
}

/** Pior resultado da onda decide o rumo da Feature. */
function aggregate(outcomes: TaskRunOutcome[]): { outcome: Outcome; reason?: string } {
  const pick = (status: TaskRunOutcome["status"]) =>
    outcomes.find((outcome) => outcome.status === status);
  const order: Array<[TaskRunOutcome["status"], Outcome]> = [
    ["cancelled", "cancelled"],
    ["needs_human", "needs_human"],
    ["failed", "failure"],
    ["paused_capacity", "paused_capacity"],
  ];
  for (const [status, outcome] of order) {
    const found = pick(status);
    if (found) return { outcome, ...(found.reason ? { reason: found.reason } : {}) };
  }
  return { outcome: "continue" };
}

export function buildFeatureGraph(deps: FeatureGraphDeps, checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(FeatureGraphState)
    .addNode("triage", async (state) => {
      await deps.features.updateStatus(state.featureId, "planning");
      return { outcome: null, failureReason: null };
    })
    .addNode("plan", async (state) => {
      await ensureIntegrationWorktree(
        state.repoPath,
        state.worktreesRoot,
        state.featureId,
        state.defaultBranch,
      );
      await deps.features.update(state.featureId, {
        integrationBranch: integrationBranchName(state.featureId),
      });

      const existing = await deps.tasks.listByFeature(state.featureId);
      if (existing.length === 0) {
        const feature = await deps.features.getById(state.featureId);
        const parsed = FeaturePlanSchema.safeParse(feature?.plan);
        let plan = parsed.success ? parsed.data : undefined;
        if (!plan || !validatePlan(plan).ok) {
          plan = singleTaskPlan(state.objective);
        }
        const ids = await appendTasks(deps.tasks, state.featureId, plan, "plan");
        await emitEvent(deps.events, deps.logger, {
          type: "feature.planned",
          projectId: state.projectId,
          featureId: state.featureId,
          payload: { tasks: ids.length, fromStoredPlan: parsed.success },
        });
      }
      await deps.features.updateStatus(state.featureId, "executing");
      return {};
    })
    .addNode("execute_wave", async (state, runtime) => {
      const control = runtime.configurable?.attemptControl as AttemptControl | undefined;
      if (control?.isCancelled()) {
        return { outcome: "cancelled" as const, failureReason: "Feature cancelada" };
      }

      const tasks = await deps.tasks.listByFeature(state.featureId);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const stuck = tasks.find((task) => task.status === "failed" || task.status === "needs_human");
      if (stuck) {
        return {
          outcome: stuck.status === "failed" ? ("failure" as const) : ("needs_human" as const),
          failureReason: `Task "${stuck.title}" está ${stuck.status}`,
        };
      }

      // Corretivas de conflito vêm antes de tudo: a integração precisa estar
      // limpa para as próximas Tasks nascerem dela.
      const pendingConflicts = tasks.filter(
        (task) => task.origin === "conflict" && !TERMINAL_TASK.has(task.status),
      );
      const ready = (pendingConflicts.length > 0 ? pendingConflicts : tasks).filter(
        (task) =>
          !TERMINAL_TASK.has(task.status) &&
          task.dependencies.every((depId) => byId.get(depId)?.status === "completed"),
      );

      if (ready.length === 0) {
        const unfinished = tasks.filter((task) => task.status !== "completed");
        return unfinished.length === 0
          ? { outcome: "integrated" as const }
          : {
              outcome: "failure" as const,
              failureReason: `Tasks bloqueadas por dependências: ${unfinished.map((task) => task.title).join(", ")}`,
            };
      }

      await emitEvent(deps.events, deps.logger, {
        type: "wave.started",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: { tasks: ready.map((task) => task.title) },
      });

      const context = contextOf(state);
      const outcomes = await Promise.all(
        ready.map((task) => runTask(deps, context, task.id, control)),
      );

      // Integração incremental (M2.7): merge das Tasks isoladas concluídas, em ordem.
      const integrationPath = integrationWorktreePath(state.worktreesRoot, state.featureId);
      const completedIsolated = (
        await Promise.all(ready.map((task) => deps.tasks.getById(task.id)))
      )
        .filter(
          (task) =>
            task?.status === "completed" && task.workspaceMode === "isolated" && task.branch,
        )
        .sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0));

      for (const task of completedIsolated) {
        if (!task?.branch) continue;
        const merge = await mergeIntoIntegration(
          integrationPath,
          task.branch,
          `apo: integra ${task.title.slice(0, 60)}`,
        );
        if (merge.status === "conflict") {
          // M2.8: conflito vira Task corretiva, nunca resolução silenciosa.
          await appendTasks(
            deps.tasks,
            state.featureId,
            {
              tasks: [
                {
                  key: "fix",
                  title: `Resolver conflito ao integrar "${task.title}"`,
                  description: [
                    `Há um merge em andamento da branch ${task.branch} nesta worktree de integração, com conflitos em: ${merge.files.join(", ")}.`,
                    "Resolva os conflitos preservando a intenção das duas partes, sem descartar trabalho de nenhuma.",
                    "Não rode `git merge --abort`.",
                  ].join(" "),
                  kind: "write",
                  role: "generic",
                  expectedPaths: merge.files,
                  dependsOn: [],
                },
              ],
            },
            "conflict",
            { branch: task.branch },
          );
          await emitEvent(deps.events, deps.logger, {
            type: "integration.conflict",
            projectId: state.projectId,
            featureId: state.featureId,
            taskId: task.id,
            payload: { files: merge.files },
          });
        } else if (merge.status === "merged") {
          await emitEvent(deps.events, deps.logger, {
            type: "integration.merged",
            projectId: state.projectId,
            featureId: state.featureId,
            taskId: task.id,
          });
        }
      }

      const result = aggregate(outcomes);
      return { outcome: result.outcome, failureReason: result.reason ?? null };
    })
    .addNode("verify", async (state) => {
      // Tasks podem ter sido anexadas depois da última onda (absorção, M2.13).
      const tasks = await deps.tasks.listByFeature(state.featureId);
      if (tasks.some((task) => task.status !== "completed")) {
        return { outcome: "continue" as const };
      }
      const verification = await verifyIntegration(
        state.repoPath,
        integrationWorktreePath(state.worktreesRoot, state.featureId),
        state.defaultBranch,
        deps.workerEnv?.(state.repoPath),
      );
      return verification.passed
        ? { outcome: "success" as const }
        : { outcome: "failure" as const, failureReason: verification.reason ?? null };
    })
    .addNode("complete", async (state) => {
      // Única escrita do status terminal da Feature.
      const finalStatus =
        state.outcome === "success"
          ? "completed"
          : state.outcome === "cancelled"
            ? "cancelled"
            : state.outcome === "paused_capacity"
              ? "paused_capacity"
              : state.outcome === "needs_human"
                ? "needs_human"
                : "failed";
      await deps.features.updateStatus(state.featureId, finalStatus);

      const resetAt =
        finalStatus === "paused_capacity"
          ? deps.capacity.earliestReset(
              candidatesOf(deps.targets).map((candidate) => candidate.provider),
            )
          : undefined;
      const payload: Record<string, unknown> = {};
      if (state.failureReason) payload.reason = state.failureReason;
      if (resetAt) payload.resumeAt = resetAt.toISOString();
      if (finalStatus === "completed")
        payload.integrationBranch = integrationBranchName(state.featureId);

      await emitEvent(deps.events, deps.logger, {
        type: `feature.${finalStatus}`,
        projectId: state.projectId,
        featureId: state.featureId,
        ...(Object.keys(payload).length > 0 ? { payload } : {}),
      });
      return {};
    })
    .addEdge(START, "triage")
    .addEdge("triage", "plan")
    .addEdge("plan", "execute_wave")
    .addConditionalEdges("execute_wave", (state) =>
      state.outcome === "continue"
        ? "execute_wave"
        : state.outcome === "integrated"
          ? "verify"
          : "complete",
    )
    .addConditionalEdges("verify", (state) =>
      state.outcome === "continue" ? "execute_wave" : "complete",
    )
    .addEdge("complete", END);

  return graph.compile({ checkpointer });
}

export type FeatureGraph = ReturnType<typeof buildFeatureGraph>;
