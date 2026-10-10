// Graph do SingleAgentEngine (ADR 0003): uma Task por Feature.
//
//   triage → plan → execute ⇄ (retry) → verify → complete
//
// M1.9: `plan` cria uma Task igual ao objetivo, sem LLM (o planner via LLM é
// o M2.5). "triage" é o node de entrada do graph, não o IntentTriage do
// ROADMAP.md §4.3 — esse decide bugfix/feature ANTES do graph começar.
//
// M3: `execute` resolve o target (ExecutionTargetResolver + RuleBasedRouter
// com capacidade), roda um attempt e, se o provider falhar, atualiza a
// capacidade, gera um handover determinístico e volta para `execute` com
// outro target — na mesma worktree e branch. Sem target disponível, a Feature
// vai para `paused_capacity`; target forçado indisponível vai para
// `needs_human`.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  RoutingDecisionRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { ExecutionPreference } from "@apo/domain";
import type { AgentFailure } from "@apo/harnesses";
import { type Logger, emitEvent } from "@apo/observability";
import {
  type CapacityMonitor,
  type ResolveResult,
  type RoutingPolicy,
  resolveExecutionTarget,
} from "@apo/routing";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { type AttemptControl, abortReasonOf } from "./attempt-control.js";
import { type TaskHandoverPayload, buildHandover, renderHandoverForPrompt } from "./handover.js";
import { type TargetRegistry, candidatesOf, findTarget } from "./harness-registry.js";
import { verifyTask } from "./verify.js";
import { commitIfDirty, ensureFeatureWorktree } from "./worktree.js";

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

type Outcome = "success" | "failure" | "cancelled" | "retry" | "paused_capacity" | "needs_human";

export const FeatureGraphState = Annotation.Root({
  featureId: Annotation<string>,
  projectId: Annotation<string>,
  repoPath: Annotation<string>,
  defaultBranch: Annotation<string>,
  objective: Annotation<string>,
  worktreesRoot: Annotation<string>,
  taskId: Annotation<string | undefined>,
  worktreePath: Annotation<string | undefined>,
  branch: Annotation<string | undefined>,
  // `null` = valor resetado explicitamente pelo triage (re-invocação após
  // recovery/pausa reaproveita o checkpoint; sem reset, um outcome antigo vazaria).
  outcome: Annotation<Outcome | null | undefined>,
  failureReason: Annotation<string | null | undefined>,
  attemptsInRun: Annotation<number | undefined>,
  excludeTargets: Annotation<string[] | undefined>,
  lastFailureWasCapacity: Annotation<boolean | undefined>,
  /** Handover a entregar ao próximo attempt. Sobrevive a pausa/restart de propósito. */
  pendingHandoverId: Annotation<string | null | undefined>,
});

export type FeatureGraphInput = Pick<
  typeof FeatureGraphState.State,
  "featureId" | "projectId" | "repoPath" | "defaultBranch" | "objective" | "worktreesRoot"
>;

export interface FeatureGraphDeps {
  logger: Logger;
  features: FeatureRepository;
  tasks: TaskRepository;
  taskAttempts: TaskAttemptRepository;
  events: EventRepository;
  routingDecisions: RoutingDecisionRepository;
  handovers: HandoverRepository;
  targets: TargetRegistry;
  capacity: CapacityMonitor;
  maxAttemptsPerTask: number;
  routingPolicy?: RoutingPolicy;
  /** Environment do worker (allowlist + extras do Project). Ausente → default do harness. */
  workerEnv?: (repoPath: string) => Record<string, string>;
  attemptLogPath?: (attemptId: string) => string;
  timeoutMs?: number;
}

const CAPACITY_FAILURES = new Set(["rate_limited", "quota_exhausted", "auth"]);
const RETRYABLE_FAILURES = new Set([
  "rate_limited",
  "quota_exhausted",
  "auth",
  "crash",
  "timeout",
  "stalled",
]);

function buildWorkerPrompt(objective: string, handover: TaskHandoverPayload | undefined): string {
  const base = `Você é um worker do orquestrador APO, trabalhando numa worktree git isolada. Implemente o seguinte objetivo e faça commit do trabalho na branch atual:\n\n${objective}`;
  return handover ? `${base}\n\n${renderHandoverForPrompt(handover)}` : base;
}

function defaultAttemptLogPath(attemptId: string): string {
  return join(homedir(), ".apo", "logs", "attempts", `${attemptId}.log`);
}

function attemptStatusFor(failure: AgentFailure | undefined) {
  if (!failure) return "completed" as const;
  if (failure.kind === "cancelled") return "cancelled" as const;
  if (failure.kind === "rate_limited") return "rate_limited" as const;
  if (failure.kind === "stalled") return "stalled" as const;
  return "failed" as const;
}

export function buildFeatureGraph(deps: FeatureGraphDeps, checkpointer: BaseCheckpointSaver) {
  const capacityOf = (provider: Parameters<CapacityMonitor["get"]>[0]) =>
    deps.capacity.get(provider);

  async function recordRouting(
    taskId: string,
    resolved: ResolveResult,
    input: Record<string, unknown>,
  ) {
    await deps.routingDecisions.insert({
      id: randomUUID(),
      taskId,
      router:
        resolved.kind === "target" && resolved.resolutionSource !== "rule_router"
          ? "override"
          : "rule",
      resolutionSource: resolved.kind === "target" ? resolved.resolutionSource : resolved.kind,
      input,
      output: {
        kind: resolved.kind,
        reason: resolved.reason,
        ...("route" in resolved && resolved.route ? { considered: resolved.route.considered } : {}),
      },
      finalTarget: resolved.kind === "target" ? resolved.target : null,
    });
  }

  const graph = new StateGraph(FeatureGraphState)
    .addNode("triage", async (state) => {
      await deps.features.updateStatus(state.featureId, "planning");
      return {
        outcome: null,
        failureReason: null,
        attemptsInRun: 0,
        excludeTargets: [],
        lastFailureWasCapacity: false,
      };
    })
    .addNode("plan", async (state) => {
      // Idempotente: recovery (M1.13) re-invoca o graph do zero — se a Task já
      // existe, reaproveita em vez de duplicar.
      const existing = await deps.tasks.listByFeature(state.featureId);
      if (existing.length > 0) {
        await deps.features.updateStatus(state.featureId, "executing");
        return { taskId: existing[0]?.id };
      }

      // A Task nasce sem override: a preferência fica na Feature (--harness) e
      // é herdada na resolução (hierarquia da seção 6.5).
      const taskId = randomUUID();
      await deps.tasks.create({
        id: taskId,
        featureId: state.featureId,
        title: state.objective.slice(0, 120),
        description: state.objective,
        kind: "write",
        status: "ready",
        dependencies: [],
      });
      await deps.features.updateStatus(state.featureId, "executing");
      return { taskId };
    })
    .addNode("execute", async (state, runtime) => {
      const taskId = state.taskId;
      if (!taskId) {
        throw new Error("feature-graph: taskId ausente ao entrar em 'execute'");
      }

      // Idempotente: se esta Task já concluiu antes de um crash (ex.: durante
      // 'verify'/'complete'), não roda o worker de novo.
      const existingTask = await deps.tasks.getById(taskId);
      if (existingTask?.status === "completed") {
        return {
          ...(existingTask.worktreePath !== null
            ? { worktreePath: existingTask.worktreePath }
            : {}),
          ...(existingTask.branch !== null ? { branch: existingTask.branch } : {}),
          outcome: "success" as const,
        };
      }

      const attemptsInRun = state.attemptsInRun ?? 0;
      if (attemptsInRun >= deps.maxAttemptsPerTask) {
        await deps.tasks.updateStatus(taskId, "failed");
        return {
          outcome: "failure" as const,
          failureReason: `limite de ${deps.maxAttemptsPerTask} attempts atingido`,
        };
      }

      const { worktreePath, branch } = await ensureFeatureWorktree(
        state.repoPath,
        state.worktreesRoot,
        state.featureId,
        state.defaultBranch,
      );
      await deps.tasks.update(taskId, { worktreePath, branch, status: "running" });

      const feature = await deps.features.getById(state.featureId);
      const taskPreference = (existingTask?.executionPreference ??
        null) as ExecutionPreference | null;
      const featurePreference = (feature?.executionPreference ??
        null) as ExecutionPreference | null;
      const exclude = state.excludeTargets ?? [];

      const resolve = (excluded: string[]) =>
        resolveExecutionTarget({
          candidates: candidatesOf(deps.targets),
          capacity: capacityOf,
          taskPreference,
          featurePreference,
          exclude: excluded,
          ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
        });
      let resolved = resolve(exclude);
      // A exclusão vem de crash/timeout (problema da Task, não do provider).
      // Se ela esvaziou as opções, tentar de novo no mesmo target é melhor do
      // que pausar por "falta de capacidade" que não existe.
      if (resolved.kind === "no_capacity" && exclude.length > 0) {
        resolved = resolve([]);
      }
      await recordRouting(taskId, resolved, {
        taskPreference,
        featurePreference,
        exclude,
        capacity: candidatesOf(deps.targets).map((candidate) => capacityOf(candidate.provider)),
      });

      if (resolved.kind === "needs_human") {
        await deps.tasks.updateStatus(taskId, "needs_human");
        return {
          worktreePath,
          branch,
          outcome: "needs_human" as const,
          failureReason: resolved.reason,
        };
      }
      if (resolved.kind === "no_capacity") {
        await deps.tasks.updateStatus(taskId, "retrying");
        return {
          worktreePath,
          branch,
          outcome: "paused_capacity" as const,
          failureReason: resolved.reason,
        };
      }

      // Depois de uma falha de capacidade, um target degradado não é
      // alternativa: tentar de novo nele só queimaria quota. Melhor pausar.
      const chosenCapacity = capacityOf(resolved.target.provider);
      if (state.lastFailureWasCapacity && chosenCapacity.availability === "degraded") {
        await deps.tasks.updateStatus(taskId, "retrying");
        return {
          worktreePath,
          branch,
          outcome: "paused_capacity" as const,
          failureReason: "só restaram providers degradados depois de uma falha de capacidade",
        };
      }

      const entry = findTarget(deps.targets, resolved.target.targetId);
      if (!entry) {
        throw new Error(
          `feature-graph: target "${resolved.target.targetId}" sem harness registrado`,
        );
      }

      const handover = state.pendingHandoverId
        ? ((await deps.handovers.getById(state.pendingHandoverId))?.payload as
            | TaskHandoverPayload
            | undefined)
        : undefined;

      const previousAttempts = await deps.taskAttempts.listByTask(taskId);
      const n = previousAttempts.length + 1;
      const attemptId = randomUUID();
      const logPath = (deps.attemptLogPath ?? defaultAttemptLogPath)(attemptId);

      await deps.taskAttempts.create({
        id: attemptId,
        taskId,
        n,
        provider: entry.harness.provider,
        harness: entry.harness.id,
        targetId: entry.candidate.targetId,
        resolutionSource: resolved.resolutionSource,
        ...(state.pendingHandoverId ? { handoverId: state.pendingHandoverId } : {}),
        ...(entry.candidate.model !== undefined ? { model: entry.candidate.model } : {}),
        logPath,
        status: "working",
      });
      await emitEvent(deps.events, deps.logger, {
        type: "attempt.started",
        projectId: state.projectId,
        featureId: state.featureId,
        taskId,
        payload: { attemptId, n, target: entry.candidate.targetId, reason: resolved.reason },
      });

      const control = runtime.configurable?.attemptControl as AttemptControl | undefined;
      const signal = control?.newAttempt() ?? new AbortController().signal;
      const env = deps.workerEnv?.(state.repoPath);

      deps.capacity.workerStarted(entry.harness.provider);
      let result: Awaited<ReturnType<typeof entry.harness.execute>>;
      try {
        result = await entry.harness.execute(
          {
            prompt: buildWorkerPrompt(state.objective, handover),
            cwd: worktreePath,
            mode: "workspace-write",
            networkAccess: false,
            timeoutMs: deps.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
            logPath,
            ...(entry.candidate.model !== undefined ? { model: entry.candidate.model } : {}),
            ...(env ? { env } : {}),
          },
          signal,
        );
      } finally {
        deps.capacity.workerFinished(entry.harness.provider);
      }

      await deps.taskAttempts.update(attemptId, {
        status: attemptStatusFor(result.failure),
        failureKind: result.failure?.kind ?? null,
        failureMessage: result.failure?.message.slice(0, 2_000) ?? null,
        endedAt: new Date(),
      });

      if (result.outcome === "success") {
        deps.capacity.recordSuccess(entry.harness.provider);
        // Git/commit é responsabilidade determinística da infraestrutura, não
        // do agente (regra 10 do PLAN.md) — o worker pode escrever os arquivos
        // certos e não comitar (confirmado na validação do M1).
        await commitIfDirty(worktreePath, `apo: wip ${state.objective.slice(0, 72)}`);
        return {
          worktreePath,
          branch,
          outcome: "success" as const,
          attemptsInRun: attemptsInRun + 1,
          pendingHandoverId: null,
        };
      }

      const failure = result.failure ?? { kind: "crash" as const, message: "falha sem detalhe" };
      const abortReason = abortReasonOf(signal);
      const failures = [
        ...previousAttempts
          .filter((attempt) => attempt.failureMessage)
          .map((attempt) => `${attempt.targetId ?? attempt.harness}: ${attempt.failureMessage}`),
        `${entry.candidate.targetId}: ${failure.message}`,
      ];

      // Reroute manual (M3.10): o attempt foi interrompido de propósito para
      // trocar de target. A nova preferência vira override da Task.
      if (failure.kind === "cancelled" && abortReason?.type === "reroute") {
        await deps.tasks.update(taskId, {
          executionPreference: abortReason.preference,
          status: "retrying",
        });
        const handoverId = await persistHandover(
          taskId,
          attemptId,
          n,
          worktreePath,
          state,
          failures,
          result.finalMessage,
        );
        await emitEvent(deps.events, deps.logger, {
          type: "task.rerouted",
          projectId: state.projectId,
          featureId: state.featureId,
          taskId,
          payload: {
            fromTarget: entry.candidate.targetId,
            preference: abortReason.preference,
            handoverId,
          },
        });
        return {
          worktreePath,
          branch,
          outcome: "retry" as const,
          attemptsInRun: attemptsInRun + 1,
          excludeTargets: [],
          lastFailureWasCapacity: false,
          pendingHandoverId: handoverId,
        };
      }

      if (failure.kind === "cancelled") {
        await deps.tasks.updateStatus(taskId, "cancelled");
        return {
          worktreePath,
          branch,
          outcome: "cancelled" as const,
          failureReason: failure.message,
        };
      }

      deps.capacity.recordFailure(entry.harness.provider, failure);
      const isCapacity = CAPACITY_FAILURES.has(failure.kind);

      if (!RETRYABLE_FAILURES.has(failure.kind) || attemptsInRun + 1 >= deps.maxAttemptsPerTask) {
        await deps.tasks.updateStatus(taskId, "failed");
        return {
          worktreePath,
          branch,
          outcome: "failure" as const,
          failureReason: failure.message,
          attemptsInRun: attemptsInRun + 1,
        };
      }

      // Failover (M3.8): handover → Task retrying → novo attempt, mesma worktree.
      await deps.tasks.updateStatus(taskId, "retrying");
      const handoverId = await persistHandover(
        taskId,
        attemptId,
        n,
        worktreePath,
        state,
        failures,
        result.finalMessage,
      );
      await emitEvent(deps.events, deps.logger, {
        type: "task.failover",
        projectId: state.projectId,
        featureId: state.featureId,
        taskId,
        payload: { fromTarget: entry.candidate.targetId, failureKind: failure.kind, handoverId },
      });

      return {
        worktreePath,
        branch,
        outcome: "retry" as const,
        attemptsInRun: attemptsInRun + 1,
        // Falha de capacidade já tira o provider da disputa via CapacityMonitor;
        // crash/timeout tira o target específico da próxima escolha.
        excludeTargets: isCapacity ? exclude : [...exclude, entry.candidate.targetId],
        lastFailureWasCapacity: isCapacity,
        pendingHandoverId: handoverId,
      };
    })
    .addNode("verify", async (state) => {
      if (state.outcome !== "success") {
        return {};
      }
      const taskId = state.taskId;
      if (!taskId || !state.worktreePath) {
        throw new Error("feature-graph: taskId/worktreePath ausentes ao entrar em 'verify'");
      }

      const verification = await verifyTask(
        state.repoPath,
        state.worktreePath,
        state.defaultBranch,
      );
      if (!verification.passed) {
        await deps.tasks.updateStatus(taskId, "failed");
        return { outcome: "failure" as const, failureReason: verification.reason ?? null };
      }

      await deps.tasks.updateStatus(taskId, "completed");
      return { outcome: "success" as const };
    })
    .addNode("complete", async (state) => {
      // Única escrita do status terminal da Feature — a rota de cancel só
      // sinaliza o AttemptControl, nunca escreve o status ela mesma.
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
    .addEdge("plan", "execute")
    .addConditionalEdges("execute", (state) =>
      state.outcome === "retry" ? "execute" : state.outcome === "success" ? "verify" : "complete",
    )
    .addEdge("verify", "complete")
    .addEdge("complete", END);

  async function persistHandover(
    taskId: string,
    attemptId: string,
    attemptNumber: number,
    worktreePath: string,
    state: typeof FeatureGraphState.State,
    failures: string[],
    lastAgentMessage: string | undefined,
  ): Promise<string> {
    const payload = await buildHandover({
      taskId,
      objective: state.objective,
      attemptNumber,
      worktreePath,
      defaultBranch: state.defaultBranch,
      failures,
      ...(lastAgentMessage !== undefined ? { lastAgentMessage } : {}),
    });
    const id = randomUUID();
    await deps.handovers.create({ id, taskId, fromAttemptId: attemptId, payload });
    return id;
  }

  return graph.compile({ checkpointer });
}

export type FeatureGraph = ReturnType<typeof buildFeatureGraph>;
