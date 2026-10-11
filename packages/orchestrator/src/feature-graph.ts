// ApoNativeEngine (ADR 0003): o graph de uma Feature.
//
//   triage → plan → execute_wave → handle_plan_changes ⇄ (próxima onda)
//     → quality → review → prepare_delivery → await_approval → create_pr → complete
//                  ↑ gate/requisito/finding falhou: Tasks corretivas (fixing) → execute_wave
//
// - plan (M2.5): usa o plano já gerado e validado na criação da Feature
//   (`features.plan`) ou cai para uma Task só. Cria a branch e a worktree de
//   integração.
// - execute_wave (M2.6/M2.7/M2.8): roda em paralelo as Tasks cujas
//   dependências já foram integradas, cada uma com failover próprio
//   (task-runner.ts), e então faz merge `--no-ff` das concluídas na integração,
//   em ordem. Conflito → `merge --abort` + Task corretiva anexada à Feature.
// - handle_plan_changes (M4.6): o Lead decide os planChangeRequests da onda.
// - quality (M4.1): build → lint → typecheck → tests na worktree de integração.
// - review (M4.2/M4.3): requisitos (Lead) + findings (Reviewer, de preferência
//   em outro provider). Falhas viram Tasks corretivas (M4.5), até
//   review.maxFixIterations; acima disso, needs_human.
// - prepare_delivery (M4.4/M4.7): completion contract — única porta para
//   awaiting_approval — e resumo de entrega.
// - await_approval (M4.8): interrupt(); `apo approve|reject` retomam com
//   Command({ resume }). Sobrevive a restart (checkpoint no Postgres).
// - create_pr (M4.9): push + `gh pr create`. Nunca faz merge.
//
// Limitação aceita (TECHNICAL_PLAN.md, "barreira de onda"): uma Task da onda
// seguinte espera a onda inteira terminar, mesmo que dependa só de uma Task
// rápida. Determinístico e simples de testar; otimização fica para depois.
//
// Os nodes são idempotentes: recovery (M1.13) e saída de paused_capacity
// (M3.9) re-invocam o graph do zero.

import { randomUUID } from "node:crypto";
import { GENERIC_ROLE_ID, loadRoleRegistry } from "@apo/config";
import type { ProviderId } from "@apo/domain";
import { emitEvent } from "@apo/observability";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { appendTasks } from "./append-tasks.js";
import type { AttemptControl } from "./attempt-control.js";
import {
  type RequirementCheck,
  type ReviewFinding,
  type Severity,
  evaluateCompletion,
  isBlocking,
} from "./completion.js";
import { GhPullRequestCreator, buildDeliverySummary } from "./delivery.js";
import { candidatesOf, findTarget } from "./harness-registry.js";
import { pickJudge } from "./judge.js";
import { distillMemories } from "./memory-writer.js";
import { PLAN_CHANGE_REQUEST, PlanChangeRequestSchema, decidePlanChange } from "./plan-changes.js";
import { type FeaturePlan, FeaturePlanSchema, singleTaskPlan, validatePlan } from "./plan.js";
import { type GateResult, QUALITY_GATES, type QualityGate, runQualityGates } from "./quality.js";
import { integrationDiff, reviewIntegration, verifyRequirements } from "./review.js";
import {
  type EngineDeps,
  type FeatureContext,
  type TaskRunOutcome,
  runTask,
} from "./task-runner.js";
import { loadProjectConfig } from "./verify.js";
import {
  ensureIntegrationWorktree,
  hasNewCommits,
  integrationBranchName,
  integrationWorktreePath,
  mergeIntoIntegration,
} from "./worktree.js";

export { DEFAULT_TASK_TIMEOUT_MS } from "./task-runner.js";

type Outcome =
  | "continue"
  | "integrated"
  | "gates_passed"
  | "ready"
  | "awaiting"
  | "deliver"
  | "approved"
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

const DEFAULT_JUDGE_TIMEOUT_MS = 15 * 60_000;
const HELD_POLL_MS = 500;
const HELD_TIMEOUT_MS = 20 * 60_000;

/**
 * Teto de passos por invocação. O padrão do LangGraph (25) estoura numa
 * Feature real: cada onda gasta 2 passos e as correções rodam em sequência.
 */
export const FEATURE_GRAPH_RECURSION_LIMIT = 1_000;

/** Resposta de `apo approve` / `apo reject` / cancel, via Command({ resume }). */
export interface ApprovalDecision {
  action: "approve" | "reject" | "cancel";
  reason?: string;
}

interface Corrective {
  title: string;
  description: string;
  expectedPaths: string[];
}

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

function abortSignalOf(runtime: {
  configurable?: Record<string, unknown> | undefined;
}): AbortSignal {
  const control = runtime.configurable?.attemptControl as AttemptControl | undefined;
  return control?.featureSignal() ?? new AbortController().signal;
}

function lastDetails<T>(
  rows: Array<{ gate: string; details: unknown }>,
  gate: string,
  key: string,
): T | undefined {
  const row = [...rows].reverse().find((candidate) => candidate.gate === gate);
  const value = (row?.details as Record<string, unknown> | null | undefined)?.[key];
  return value === null || value === undefined ? undefined : (value as T);
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
  const judgeTimeout = deps.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;

  function reviewConfig(repoPath: string): {
    blockingSeverity: Severity;
    maxFixIterations: number;
  } {
    const review = loadProjectConfig(repoPath).review;
    return {
      blockingSeverity: review?.blockingSeverity ?? "medium",
      maxFixIterations: review?.maxFixIterations ?? 3,
    };
  }

  /** M4.5: nova rodada de correção, ou needs_human se o limite estourou. */
  async function startFixRound(
    state: typeof FeatureGraphState.State,
    items: Corrective[],
    origin: string,
    reason: string,
  ): Promise<{ outcome: Outcome; failureReason?: string | null }> {
    const feature = await deps.features.getById(state.featureId);
    const iteration = feature?.fixIteration ?? 0;
    const { maxFixIterations } = reviewConfig(state.repoPath);
    if (iteration >= maxFixIterations) {
      return {
        outcome: "needs_human",
        failureReason: `limite de ${maxFixIterations} rodadas de correção atingido: ${reason}`,
      };
    }
    // Em sequência, não em paralelo (achado do E2E real do M6): as correções de
    // uma rodada costumam mexer nos mesmos arquivos, e em paralelo geravam uma
    // cascata de conflitos de merge. Cada uma nasce da integração com a anterior.
    const plan: FeaturePlan = {
      tasks: items.map((item, index) => ({
        key: `f${index}`,
        title: item.title,
        description: item.description,
        kind: "write",
        role: GENERIC_ROLE_ID,
        expectedPaths: item.expectedPaths,
        dependsOn: index === 0 ? [] : [`f${index - 1}`],
      })),
    };
    const ids = await appendTasks(deps.tasks, state.featureId, plan, origin);
    await deps.features.update(state.featureId, { fixIteration: iteration + 1 });
    await deps.features.updateStatus(state.featureId, "fixing");
    await emitEvent(deps.events, deps.logger, {
      type: "feature.fixing",
      projectId: state.projectId,
      featureId: state.featureId,
      payload: { iteration: iteration + 1, origin, reason, taskIds: ids },
    });
    return { outcome: "continue", failureReason: null };
  }

  /**
   * Objetivo + o que entrou depois: motivos de reject (M4.8) e pedidos
   * absorvidos (M2.13). Sem isso, a verificação de requisitos só olharia o
   * pedido original e aprovaria um ajuste humano não feito.
   */
  async function objectiveWithAdditions(state: typeof FeatureGraphState.State): Promise<string> {
    const additions: string[] = [];
    for (const event of await deps.events.listByFeature(state.featureId)) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === "feature.rejected" && typeof payload.reason === "string") {
        additions.push(`(pedido na revisão humana) ${payload.reason}`);
      }
      if (event.type === "feature.requirement_updated" && typeof payload.change === "string") {
        additions.push(`(requisito alterado) ${payload.change}`);
      }
      if (
        event.type === "feature.request_absorbed" &&
        typeof payload.originalObjective === "string"
      ) {
        additions.push(`(pedido absorvido) ${payload.originalObjective}`);
      }
    }
    return additions.length === 0
      ? state.objective
      : `${state.objective}\n\nRequisitos adicionados depois (também fazem parte do objetivo):\n${additions.map((item) => `- ${item}`).join("\n")}`;
  }

  async function latestGates(featureId: string, iteration: number) {
    const rows = await deps.qualityResults.listByFeature(featureId);
    const gates: Partial<Record<QualityGate, "passed" | "failed" | "skipped">> = {};
    for (const row of rows) {
      if (row.iteration !== iteration) continue;
      if ((QUALITY_GATES as readonly string[]).includes(row.gate)) {
        gates[row.gate as QualityGate] = row.status as "passed" | "failed" | "skipped";
      }
    }
    return gates;
  }

  /** Provider que mais implementou (dica preferDifferentProviderFrom, M4.3). */
  async function mostUsedProvider(featureId: string): Promise<ProviderId | undefined> {
    const counts = new Map<ProviderId, number>();
    for (const task of await deps.tasks.listByFeature(featureId)) {
      for (const attempt of await deps.taskAttempts.listByTask(task.id)) {
        if (attempt.status !== "completed" || !attempt.targetId) continue;
        const provider = findTarget(deps.targets, attempt.targetId)?.candidate.provider;
        if (provider) counts.set(provider, (counts.get(provider) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

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

      // M6.4: Tasks `pending` estão seguradas por um replan em andamento. Se só
      // restam elas, espera o plano novo aqui dentro (sem gastar passos do
      // graph) em vez de concluir a Feature sem o trabalho replanejado.
      const waitStarted = Date.now();
      let tasks = await deps.tasks.listByFeature(state.featureId);
      let byId = new Map(tasks.map((task) => [task.id, task]));
      let ready: typeof tasks = [];
      for (;;) {
        tasks = await deps.tasks.listByFeature(state.featureId);
        byId = new Map(tasks.map((task) => [task.id, task]));
        const stuck = tasks.find(
          (task) => task.status === "failed" || task.status === "needs_human",
        );
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
        ready = (pendingConflicts.length > 0 ? pendingConflicts : tasks).filter(
          (task) =>
            !TERMINAL_TASK.has(task.status) &&
            task.status !== "pending" &&
            task.dependencies.every((depId) => byId.get(depId)?.status === "completed"),
        );
        const held = tasks.filter((task) => task.status === "pending");
        if (ready.length > 0 || held.length === 0) break;
        if (control?.isCancelled()) {
          return { outcome: "cancelled" as const, failureReason: "Feature cancelada" };
        }
        if (Date.now() - waitStarted > HELD_TIMEOUT_MS) {
          // Replan que nunca terminou (ex.: daemon caiu no meio): solta as Tasks.
          for (const task of held) await deps.tasks.transitionIf(task.id, ["pending"], "ready");
          await emitEvent(deps.events, deps.logger, {
            type: "replan.hold_released",
            projectId: state.projectId,
            featureId: state.featureId,
            payload: { tasks: held.map((task) => task.id) },
          });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, HELD_POLL_MS));
      }

      if (ready.length === 0) {
        // Cancelada pelo replan (M6.4) conta como resolvida.
        const unfinished = tasks.filter(
          (task) => task.status !== "completed" && task.status !== "cancelled",
        );
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
    .addNode("handle_plan_changes", async (state, runtime) => {
      if (state.outcome !== "continue" && state.outcome !== "integrated") return {};
      const pending = await deps.agentMessages.listPending(state.featureId, PLAN_CHANGE_REQUEST);
      if (pending.length === 0) return {};

      const judge = pickJudge(deps);
      if (!judge) {
        return {
          outcome: "paused_capacity" as const,
          failureReason: "nenhum target para o Lead decidir mudanças de plano",
        };
      }
      const signal = abortSignalOf(runtime);
      const roleIds = [...(deps.loadRoles ?? loadRoleRegistry)(state.repoPath).keys()];
      let created = 0;
      for (const message of pending) {
        const request = PlanChangeRequestSchema.parse(message.payload);
        const tasks = await deps.tasks.listByFeature(state.featureId);
        const decision = await decidePlanChange(
          judge.runner,
          {
            objective: state.objective,
            request,
            existingTasks: tasks.map((task) => `#${task.seq} ${task.title} [${task.status}]`),
            roleIds,
            cwd: integrationWorktreePath(state.worktreesRoot, state.featureId),
            timeoutMs: judgeTimeout,
          },
          signal,
        );
        if (!decision || decision.decision === "ask_human") {
          await deps.agentMessages.resolve(
            message.id,
            "escalated",
            decision ?? { reason: "Lead não decidiu" },
          );
          await emitEvent(deps.events, deps.logger, {
            type: "plan_change.escalated",
            projectId: state.projectId,
            featureId: state.featureId,
            payload: { request, reason: decision?.reason ?? "Lead não decidiu" },
          });
          return {
            outcome: "needs_human" as const,
            failureReason: `mudança de plano precisa de decisão humana: ${request.title}`,
          };
        }
        if (decision.decision === "reject") {
          await deps.agentMessages.resolve(message.id, "rejected", decision);
        } else if (decision.task) {
          const ids = await appendTasks(
            deps.tasks,
            state.featureId,
            { tasks: [{ key: "pc", ...decision.task, dependsOn: [] }] },
            "plan_change",
          );
          await deps.agentMessages.resolve(message.id, "accepted", { ...decision, taskIds: ids });
          created += ids.length;
        }
        await emitEvent(deps.events, deps.logger, {
          type: `plan_change.${decision.decision === "reject" ? "rejected" : "accepted"}`,
          projectId: state.projectId,
          featureId: state.featureId,
          payload: { request, reason: decision.reason },
        });
      }
      return created > 0 && state.outcome === "integrated" ? { outcome: "continue" as const } : {};
    })
    .addNode("quality", async (state) => {
      // Tasks podem ter sido anexadas depois da última onda (absorção, M2.13).
      const tasks = await deps.tasks.listByFeature(state.featureId);
      if (tasks.some((task) => task.status !== "completed" && task.status !== "cancelled")) {
        return { outcome: "continue" as const };
      }
      const integrationPath = integrationWorktreePath(state.worktreesRoot, state.featureId);
      if (!(await hasNewCommits(integrationPath, state.defaultBranch))) {
        return {
          outcome: "failure" as const,
          failureReason: "nenhum commit novo na branch de integração",
        };
      }

      await deps.features.updateStatus(state.featureId, "validating");
      const iteration = (await deps.features.getById(state.featureId))?.fixIteration ?? 0;
      const results = await runQualityGates(
        state.repoPath,
        integrationPath,
        deps.workerEnv?.(state.repoPath),
      );
      for (const result of results) {
        await deps.qualityResults.create({
          featureId: state.featureId,
          iteration,
          gate: result.gate,
          status: result.status,
          command: result.command ?? null,
          output: result.output ?? null,
          durationMs: result.durationMs,
        });
      }
      await emitEvent(deps.events, deps.logger, {
        type: "quality.completed",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: { iteration, gates: Object.fromEntries(results.map((r) => [r.gate, r.status])) },
      });

      const failed = results.find((result) => result.status === "failed");
      if (!failed) return { outcome: "gates_passed" as const };
      return startFixRound(
        state,
        [
          {
            title: `Corrigir o gate ${failed.gate}`,
            description: [
              `O quality gate "${failed.gate}" falhou na branch de integração${failed.command ? ` (comando: ${failed.command})` : ""}.`,
              "Corrija a causa no código, sem desligar regras, apagar testes ou mudar a configuração do gate.",
              "Saída (final):",
              failed.output ?? "",
            ].join("\n\n"),
            expectedPaths: [],
          },
        ],
        "quality_fix",
        `gate ${failed.gate} falhou`,
      );
    })
    .addNode("review", async (state, runtime) => {
      await deps.features.updateStatus(state.featureId, "reviewing");
      const integrationPath = integrationWorktreePath(state.worktreesRoot, state.featureId);
      const iteration = (await deps.features.getById(state.featureId))?.fixIteration ?? 0;
      const signal = abortSignalOf(runtime);

      const lead = pickJudge(deps);
      const reviewer = pickJudge(deps, await mostUsedProvider(state.featureId));
      if (!lead || !reviewer) {
        return {
          outcome: "paused_capacity" as const,
          failureReason: "nenhum target para o review",
        };
      }
      const gates = await latestGates(state.featureId, iteration);
      const context = {
        objective: await objectiveWithAdditions(state),
        diff: await integrationDiff(integrationPath, state.defaultBranch),
        gatesSummary: QUALITY_GATES.map((gate) => `${gate}=${gates[gate] ?? "não rodou"}`).join(
          ", ",
        ),
        cwd: integrationPath,
        timeoutMs: judgeTimeout,
      };

      const requirements = await verifyRequirements(lead.runner, context, signal);
      await deps.qualityResults.create({
        featureId: state.featureId,
        iteration,
        gate: "requirements",
        status: requirements.checks
          ? requirements.checks.every((c) => c.satisfied)
            ? "passed"
            : "failed"
          : "error",
        output: requirements.error ?? null,
        details: { checks: requirements.checks ?? null, target: lead.entry.candidate.targetId },
      });
      const review = await reviewIntegration(reviewer.runner, context, signal);
      await deps.qualityResults.create({
        featureId: state.featureId,
        iteration,
        gate: "review",
        status: review.findings ? "passed" : "error",
        output: review.error ?? null,
        details: { findings: review.findings ?? null, target: reviewer.entry.candidate.targetId },
      });
      if (!requirements.checks || !review.findings) {
        return {
          outcome: "needs_human" as const,
          failureReason: `review não pôde rodar: ${requirements.error ?? review.error}`,
        };
      }

      const verdict = evaluateCompletion({
        gates,
        requirements: requirements.checks,
        findings: review.findings,
        blockingSeverity: reviewConfig(state.repoPath).blockingSeverity,
      });
      await emitEvent(deps.events, deps.logger, {
        type: "review.completed",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: {
          iteration,
          reviewer: reviewer.entry.candidate.targetId,
          findings: review.findings.length,
          blocking: verdict.blockingFindings.length,
          missingRequirements: verdict.missingRequirements.length,
        },
      });
      if (verdict.ready) return { outcome: "ready" as const };

      const corrective: Corrective[] = [
        ...verdict.missingRequirements.map((check) => ({
          title: `Atender requisito: ${check.requirement}`.slice(0, 120),
          description: `A verificação de requisitos concluiu que este requisito do objetivo não está atendido: ${check.requirement}${check.evidence ? `\n\nEvidência: ${check.evidence}` : ""}`,
          expectedPaths: [],
        })),
        ...verdict.blockingFindings.map((finding) => ({
          title: `Review (${finding.severity}): ${finding.description}`.slice(0, 120),
          description: [
            `Finding do review (${finding.severity})${finding.file ? ` em ${finding.file}` : ""}: ${finding.description}`,
            finding.suggestedFix ? `Correção sugerida: ${finding.suggestedFix}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          expectedPaths: finding.file ? [finding.file] : [],
        })),
      ];
      return startFixRound(state, corrective, "review_fix", verdict.reasons.join("; "));
    })
    .addNode("prepare_delivery", async (state) => {
      const feature = await deps.features.getById(state.featureId);
      const iteration = feature?.fixIteration ?? 0;
      const rows = (await deps.qualityResults.listByFeature(state.featureId)).filter(
        (row) => row.iteration === iteration,
      );
      const requirements = lastDetails<RequirementCheck[]>(rows, "requirements", "checks");
      const findings = lastDetails<ReviewFinding[]>(rows, "review", "findings");
      const gates = await latestGates(state.featureId, iteration);

      // M4.4: única porta para awaiting_approval — recalculado do que foi persistido.
      const verdict = evaluateCompletion({
        gates,
        requirements,
        findings,
        blockingSeverity: reviewConfig(state.repoPath).blockingSeverity,
      });
      if (!verdict.ready) {
        return {
          outcome: "failure" as const,
          failureReason: `completion contract não satisfeito: ${verdict.reasons.join("; ")}`,
        };
      }

      const tasks = (await deps.tasks.listByFeature(state.featureId)).sort((a, b) => a.seq - b.seq);
      const summary = buildDeliverySummary({
        objective: state.objective,
        integrationBranch: integrationBranchName(state.featureId),
        tasks: tasks.map((task) => ({
          seq: task.seq,
          title: task.title,
          summary: task.summary,
          actualChangedPaths: task.actualChangedPaths,
        })),
        gates: rows
          .filter((row) => (QUALITY_GATES as readonly string[]).includes(row.gate))
          .map((row) => ({
            gate: row.gate as QualityGate,
            status: row.status as GateResult["status"],
            ...(row.command ? { command: row.command } : {}),
            durationMs: row.durationMs ?? 0,
          })),
        requirements: requirements ?? [],
        findings: findings ?? [],
        verdict,
        fixIterations: iteration,
      });
      await deps.features.update(state.featureId, { deliverySummary: summary });

      if (!loadProjectConfig(state.repoPath).git?.requirePrApproval) {
        return { outcome: "deliver" as const };
      }
      await deps.features.updateStatus(state.featureId, "awaiting_approval");
      await emitEvent(deps.events, deps.logger, {
        type: "feature.awaiting_pr_approval",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: { integrationBranch: integrationBranchName(state.featureId) },
      });
      return { outcome: "awaiting" as const };
    })
    .addNode("await_approval", async (state) => {
      // Sem efeitos colaterais antes do interrupt: o node re-executa do início
      // quando é retomado.
      const decision = interrupt({ featureId: state.featureId }) as ApprovalDecision;
      if (decision.action === "approve") {
        await emitEvent(deps.events, deps.logger, {
          type: "feature.approved",
          projectId: state.projectId,
          featureId: state.featureId,
        });
        return { outcome: "approved" as const };
      }
      if (decision.action === "cancel") {
        return { outcome: "cancelled" as const, failureReason: "Feature cancelada na aprovação" };
      }
      const reason = decision.reason?.trim() || "rejeitada sem motivo";
      await deps.features.updateStatus(state.featureId, "rejected");
      await emitEvent(deps.events, deps.logger, {
        type: "feature.rejected",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: { reason },
      });
      return startFixRound(
        state,
        [
          {
            title: "Ajustar conforme a revisão humana",
            description: `O PR foi rejeitado na aprovação com este motivo:\n\n${reason}\n\nFaça os ajustes pedidos.`,
            expectedPaths: [],
          },
        ],
        "human_fix",
        `rejeitada: ${reason}`,
      );
    })
    .addNode("create_pr", async (state) => {
      await deps.features.updateStatus(state.featureId, "delivering");
      const feature = await deps.features.getById(state.featureId);
      if (feature?.prUrl) return { outcome: "success" as const };
      let pr: { url: string };
      try {
        pr = await (deps.pullRequests ?? new GhPullRequestCreator()).create({
          repoPath: state.repoPath,
          integrationPath: integrationWorktreePath(state.worktreesRoot, state.featureId),
          branch: integrationBranchName(state.featureId),
          base: state.defaultBranch,
          title:
            state.objective.length > 72 ? `${state.objective.slice(0, 69)}...` : state.objective,
          body: feature?.deliverySummary ?? state.objective,
        });
      } catch (error) {
        // Sem remote, sem `gh auth`, push recusado: o humano resolve e aprova de novo.
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: "needs_human" as const,
          failureReason: `falha ao abrir o PR: ${message.slice(0, 500)}`,
        };
      }
      await deps.features.update(state.featureId, { prUrl: pr.url });
      await emitEvent(deps.events, deps.logger, {
        type: "feature.pr_created",
        projectId: state.projectId,
        featureId: state.featureId,
        payload: { url: pr.url },
      });
      return { outcome: "success" as const };
    })
    .addNode("remember", async (state, runtime) => {
      // M5.10 — falhar aqui nunca muda o resultado da Feature.
      if (state.outcome !== "success" || !deps.memory) return {};
      try {
        const judge = pickJudge(deps);
        if (!judge) return {};
        const feature = await deps.features.getById(state.featureId);
        const rows = await deps.qualityResults.listByFeature(state.featureId);
        const findings = rows
          .filter((row) => row.gate === "review")
          .flatMap((row) => lastDetails<ReviewFinding[]>([row], "review", "findings") ?? [])
          .map((finding) => `[${finding.severity}] ${finding.description}`);
        const corrections = (await deps.events.listByFeature(state.featureId))
          .filter((event) => event.type === "feature.rejected")
          .map((event) => String((event.payload as { reason?: string } | null)?.reason ?? ""));
        const failures: string[] = [];
        for (const task of await deps.tasks.listByFeature(state.featureId)) {
          for (const attempt of await deps.taskAttempts.listByTask(task.id)) {
            if (attempt.failureKind && attempt.failureMessage) {
              failures.push(
                `${task.title}: ${attempt.failureKind} — ${attempt.failureMessage.slice(0, 200)}`,
              );
            }
          }
        }
        const items = await distillMemories(
          judge.runner,
          {
            objective: await objectiveWithAdditions(state),
            deliverySummary: feature?.deliverySummary ?? "",
            findings,
            corrections,
            failures,
          },
          {
            cwd: integrationWorktreePath(state.worktreesRoot, state.featureId),
            timeoutMs: judgeTimeout,
          },
          abortSignalOf(runtime),
        );
        if (items && items.length > 0) {
          const saved = await deps.memory.remember(
            state.projectId,
            `feature:${state.featureId}`,
            items,
          );
          await emitEvent(deps.events, deps.logger, {
            type: "memory.written",
            projectId: state.projectId,
            featureId: state.featureId,
            payload: { count: saved, kinds: items.map((item) => item.kind) },
          });
        }
      } catch (error) {
        await emitEvent(deps.events, deps.logger, {
          type: "memory.write_failed",
          projectId: state.projectId,
          featureId: state.featureId,
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      }
      return {};
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
      if (finalStatus === "completed") {
        payload.integrationBranch = integrationBranchName(state.featureId);
        const prUrl = (await deps.features.getById(state.featureId))?.prUrl;
        if (prUrl) payload.prUrl = prUrl;
      }

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
    .addEdge("execute_wave", "handle_plan_changes")
    .addConditionalEdges("handle_plan_changes", (state) =>
      state.outcome === "continue"
        ? "execute_wave"
        : state.outcome === "integrated"
          ? "quality"
          : "complete",
    )
    .addConditionalEdges("quality", (state) =>
      state.outcome === "continue"
        ? "execute_wave"
        : state.outcome === "gates_passed"
          ? "review"
          : "complete",
    )
    .addConditionalEdges("review", (state) =>
      state.outcome === "continue"
        ? "execute_wave"
        : state.outcome === "ready"
          ? "prepare_delivery"
          : "complete",
    )
    .addConditionalEdges("prepare_delivery", (state) =>
      state.outcome === "awaiting"
        ? "await_approval"
        : state.outcome === "deliver"
          ? "create_pr"
          : "complete",
    )
    .addConditionalEdges("await_approval", (state) =>
      state.outcome === "approved"
        ? "create_pr"
        : state.outcome === "continue"
          ? "execute_wave"
          : "complete",
    )
    .addEdge("create_pr", "remember")
    .addEdge("remember", "complete")
    .addEdge("complete", END);

  return graph.compile({ checkpointer });
}

export type FeatureGraph = ReturnType<typeof buildFeatureGraph>;
