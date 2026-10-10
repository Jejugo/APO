// Graph mínimo (M1.9): triage → plan → execute → verify → complete, com
// PostgresSaver. `plan` cria uma Task igual ao objetivo, sem LLM — o planner
// via LLM (DAG de N Tasks) só chega no M2.5. "triage" aqui é o node de
// entrada do graph (carrega/prepara a Feature), não o IntentTriage do
// ROADMAP.md §4.3 — esse já decidiu bugfix/feature ANTES do graph começar.

import { randomUUID } from "node:crypto";
import type {
  EventRepository,
  FeatureRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { ExecutionPreference, HarnessId } from "@apo/domain";
import { type Logger, emitEvent } from "@apo/observability";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { HarnessRegistry } from "./harness-registry.js";
import { resolveHarness } from "./harness-registry.js";
import { verifyTask } from "./verify.js";
import { commitIfDirty, ensureFeatureWorktree } from "./worktree.js";

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export const FeatureGraphState = Annotation.Root({
  featureId: Annotation<string>,
  projectId: Annotation<string>,
  repoPath: Annotation<string>,
  defaultBranch: Annotation<string>,
  objective: Annotation<string>,
  harness: Annotation<HarnessId>,
  worktreesRoot: Annotation<string>,
  taskId: Annotation<string | undefined>,
  worktreePath: Annotation<string | undefined>,
  branch: Annotation<string | undefined>,
  outcome: Annotation<"success" | "failure" | "cancelled" | undefined>,
  failureReason: Annotation<string | undefined>,
});

export type FeatureGraphInput = typeof FeatureGraphState.State;

export interface FeatureGraphDeps {
  logger: Logger;
  features: FeatureRepository;
  tasks: TaskRepository;
  taskAttempts: TaskAttemptRepository;
  events: EventRepository;
  harnessRegistry: HarnessRegistry;
}

function buildWorkerPrompt(objective: string): string {
  return `Você é um worker do orquestrador APO, trabalhando numa worktree git isolada. Implemente o seguinte objetivo e faça commit do trabalho na branch atual:\n\n${objective}`;
}

export function buildFeatureGraph(deps: FeatureGraphDeps, checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(FeatureGraphState)
    .addNode("triage", async (state) => {
      await deps.features.updateStatus(state.featureId, "planning");
      return {};
    })
    .addNode("plan", async (state) => {
      // Idempotente: recovery (M1.13) re-invoca o graph do zero depois de um
      // restart do daemon — se a Task já existe (crash depois de 'plan'),
      // reaproveita em vez de duplicar.
      const existing = await deps.tasks.listByFeature(state.featureId);
      if (existing.length > 0) {
        await deps.features.updateStatus(state.featureId, "executing");
        return { taskId: existing[0]?.id };
      }

      const taskId = randomUUID();
      const executionPreference: ExecutionPreference = { mode: "forced", harness: state.harness };
      await deps.tasks.create({
        id: taskId,
        featureId: state.featureId,
        title: state.objective.slice(0, 120),
        description: state.objective,
        kind: "write",
        status: "ready",
        dependencies: [],
        executionPreference,
      });
      await deps.features.updateStatus(state.featureId, "executing");
      return { taskId };
    })
    .addNode("execute", async (state, runtime) => {
      const taskId = state.taskId;
      if (!taskId) {
        throw new Error("feature-graph: taskId ausente ao entrar em 'execute'");
      }

      // Idempotente: se um recovery re-invoca o graph e esta Task já tinha
      // concluído antes do crash (ex.: crash durante 'verify'/'complete'),
      // não roda o worker de novo.
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

      const { worktreePath, branch } = await ensureFeatureWorktree(
        state.repoPath,
        state.worktreesRoot,
        state.featureId,
        state.defaultBranch,
      );
      await deps.tasks.update(taskId, { worktreePath, branch, status: "running" });

      const existingAttempts = await deps.taskAttempts.listByTask(taskId);
      const n = existingAttempts.length + 1;
      const harness = resolveHarness(deps.harnessRegistry, state.harness);
      const attemptId = randomUUID();

      await deps.taskAttempts.create({
        id: attemptId,
        taskId,
        n,
        provider: harness.provider,
        harness: harness.id,
        status: "working",
      });

      // Lido de `configurable`, não do `signal` de nível top do invoke() —
      // ver o comentário em FeatureRunner.run() (apps/daemon) sobre por quê.
      const cancelSignal =
        (runtime.configurable?.cancelSignal as AbortSignal | undefined) ??
        new AbortController().signal;

      const result = await harness.execute(
        {
          prompt: buildWorkerPrompt(state.objective),
          cwd: worktreePath,
          mode: "workspace-write",
          networkAccess: false,
          timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
          logPath: `${worktreePath}.log`,
        },
        cancelSignal,
      );

      await deps.taskAttempts.update(attemptId, {
        status: result.outcome === "success" ? "completed" : "failed",
        failureKind: result.failure?.kind ?? null,
        endedAt: new Date(),
      });

      if (result.outcome === "success") {
        // Git/commit é responsabilidade determinística da infraestrutura, não
        // do agente (regra 10 do PLAN.md) — confirmado necessário em execução
        // real: o worker pode escrever os arquivos certos e não comitar.
        await commitIfDirty(worktreePath, `apo: wip ${state.objective.slice(0, 72)}`);
      }

      if (result.outcome === "failure") {
        const cancelled = result.failure?.kind === "cancelled";
        await deps.tasks.updateStatus(taskId, cancelled ? "cancelled" : "failed");
        return {
          worktreePath,
          branch,
          outcome: cancelled ? ("cancelled" as const) : ("failure" as const),
          failureReason: result.failure?.message ?? "falha desconhecida do harness",
        };
      }

      return { worktreePath, branch, outcome: "success" as const };
    })
    .addNode("verify", async (state) => {
      if (state.outcome === "failure" || state.outcome === "cancelled") {
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
        return { outcome: "failure" as const, failureReason: verification.reason };
      }

      await deps.tasks.updateStatus(taskId, "completed");
      return { outcome: "success" as const };
    })
    .addNode("complete", async (state) => {
      // Única escrita do status terminal da Feature — a rota de cancel (M1.16)
      // só aborta o AbortSignal, nunca escreve o status ela mesma, pra não
      // disputar com esta escrita (quem persistir por último "ganharia").
      const finalStatus =
        state.outcome === "success"
          ? "completed"
          : state.outcome === "cancelled"
            ? "cancelled"
            : "failed";
      await deps.features.updateStatus(state.featureId, finalStatus);
      await emitEvent(deps.events, deps.logger, {
        type: `feature.${finalStatus}`,
        projectId: state.projectId,
        featureId: state.featureId,
        ...(state.failureReason !== undefined ? { payload: { reason: state.failureReason } } : {}),
      });
      return {};
    })
    .addEdge(START, "triage")
    .addEdge("triage", "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "verify")
    .addEdge("verify", "complete")
    .addEdge("complete", END);

  return graph.compile({ checkpointer });
}

export type FeatureGraph = ReturnType<typeof buildFeatureGraph>;
