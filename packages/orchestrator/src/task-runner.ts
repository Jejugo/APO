// Execução de UMA Task no ApoNativeEngine (M2.4, o "WorkerManager"): resolve o
// workspace (M2.2), monta o prompt (M2.16), resolve o target com capacidade
// (M3) e roda attempts com failover + handover até concluir, pausar por
// capacidade, pedir humano ou esgotar os attempts. Várias Tasks rodam isto em
// paralelo dentro de uma onda do graph.
//
// O estado do laço (exclude, handover pendente) é local à chamada. Depois de um
// restart do daemon a Task roda de novo do começo, e o handover mais recente
// persistido em `handovers` é reaproveitado — a durabilidade vem do banco, não
// do checkpoint do graph.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GENERIC_ROLE_ID, type RoleDefinition, loadRoleRegistry } from "@apo/config";
import type {
  AgentMessageRepository,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  SettingsRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { ExecutionPreference } from "@apo/domain";
import type { AgentExecutionInput, AgentFailure } from "@apo/harnesses";
import { type Logger, emitEvent } from "@apo/observability";
import {
  type CapacityMonitor,
  type ResolveResult,
  type RoutingPolicy,
  type SemanticDecision,
  type TaskRouter,
  resolveExecutionTarget,
} from "@apo/routing";
import { z } from "zod";
import { type AttemptControl, abortReasonOf } from "./attempt-control.js";
import type { PullRequestCreator } from "./delivery.js";
import { type TaskHandoverPayload, buildHandover } from "./handover.js";
import {
  type ExecutionTargetEntry,
  type TargetRegistry,
  candidatesOf,
  findTarget,
} from "./harness-registry.js";
import { pickJudge } from "./judge.js";
import type { MemoryPort } from "./memory-writer.js";
import { PLAN_CHANGE_REQUEST, PlanChangeRequestSchema } from "./plan-changes.js";
import { type AnsweredQuestion, buildResumePrompt, buildWorkerPrompt } from "./prompt-builder.js";
import {
  LEAD_FIRST_MIN_CONFIDENCE,
  type QuestionPayload,
  WorkerQuestionSchema,
  askQuestion,
  effectiveQuestionMode,
  markAnswerConsumed,
  pendingAnswerFor,
  questionLimits,
  questionsAskedBy,
  resolveWithLead,
} from "./questions.js";
import { loadProjectConfig, prepareWorktree } from "./verify.js";
import type { WorkerSlots } from "./worker-slots.js";
import { type WorkspaceMode, decideWorkspace } from "./workspace-policy.js";
import {
  abortMergeIfAny,
  changedPathsSince,
  commitIfDirty,
  ensureTaskWorktree,
  hasConflictMarkers,
  hasNewCommits,
  integrationBranchName,
  integrationWorktreePath,
  startConflictMerge,
  taskBranchName,
} from "./worktree.js";

export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export interface EngineDeps {
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
  /** Semáforo do daemon inteiro (maxGlobalWorkers/maxWorkersPerProvider). */
  slots?: WorkerSlots;
  /** Environment do worker (allowlist + extras do Project). */
  workerEnv?: (repoPath: string) => Record<string, string>;
  attemptLogPath?: (attemptId: string) => string;
  /** Onde ficam os `result.json` (fora do repo, seção 6.3). */
  runsRoot?: string;
  loadRoles?: (repoPath: string) => Map<string, RoleDefinition>;
  timeoutMs?: number;
  /** M2.3: sem saída e sem escrita em disco por esse tempo → `stalled` (retryable). */
  stallTimeoutMs?: number;
  /** M4: gates, requisitos e review por iteração. */
  qualityResults: QualityResultRepository;
  /** M4.6: plan_change_request. */
  agentMessages: AgentMessageRepository;
  /** M4.9: ausente → `gh` (GhPullRequestCreator). */
  pullRequests?: PullRequestCreator;
  /** Timeout das chamadas de julgamento (Lead/Reviewer) dentro do graph. */
  judgeTimeoutMs?: number;
  /** M5: roteamento semântico (Jev). Ausente ou falhando → RuleBasedRouter (M5.4). */
  taskRouter?: TaskRouter;
  /** M5.9/M5.10: memória do projeto. Ausente ou falhando → prompt sem memória. */
  memory?: MemoryPort;
  /** M7: modo global das perguntas (`apo questions auto on|off`). */
  settings?: SettingsRepository;
}

export interface FeatureContext {
  featureId: string;
  projectId: string;
  repoPath: string;
  defaultBranch: string;
  objective: string;
  worktreesRoot: string;
}

export type TaskRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_human"
  | "paused_capacity"
  /** Cancelada por replan antes de começar (M6.4) — não afeta a Feature. */
  | "skipped"
  /** M7: o worker perguntou e a resposta é do usuário — a Task espera. */
  | "awaiting_answer";

export interface TaskRunOutcome {
  status: TaskRunStatus;
  reason?: string;
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

const WorkerReportSchema = z.object({
  summary: z.string().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
  // M4.6: pedidos de mudança de plano, decididos pelo Lead depois da onda.
  planChangeRequests: z.array(PlanChangeRequestSchema).optional(),
  // M7: pergunta ao usuário (ou ao Lead, conforme o modo).
  question: WorkerQuestionSchema.optional(),
});

function attemptStatusFor(failure: AgentFailure | undefined) {
  if (!failure) return "completed" as const;
  if (failure.kind === "cancelled") return "cancelled" as const;
  if (failure.kind === "rate_limited") return "rate_limited" as const;
  if (failure.kind === "stalled") return "stalled" as const;
  return "failed" as const;
}

async function readWorkerReport(path: string) {
  try {
    const parsed = WorkerReportSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Relatório é opcional (seção 6.3): ausente ou inválido não falha a Task.
    return undefined;
  }
}

export async function runTask(
  deps: EngineDeps,
  feature: FeatureContext,
  taskId: string,
  control: AttemptControl | undefined,
): Promise<TaskRunOutcome> {
  const task = await deps.tasks.getById(taskId);
  if (!task) throw new Error(`runTask: Task ${taskId} não existe`);
  if (task.status === "completed") return { status: "completed" };
  if (task.status === "cancelled") return { status: "skipped", reason: "cancelada pelo replan" };
  // Reivindica a Task antes de qualquer trabalho lento (worktree, prepare): o
  // replan só cancela o que ainda está pending/ready, e as duas transições são
  // atômicas — quem chegar primeiro ganha.
  // `pending` = segurada por um replan (M6.4): não pode ser reivindicada.
  const claimed = await deps.tasks.transitionIf(
    taskId,
    ["ready", "retrying", "running"],
    "running",
  );
  if (!claimed) return { status: "skipped", reason: "segurada ou cancelada pelo replan" };

  const capacityOf = (provider: Parameters<CapacityMonitor["get"]>[0]) =>
    deps.capacity.get(provider);
  const integrationBranch = integrationBranchName(feature.featureId);
  const integrationPath = integrationWorktreePath(feature.worktreesRoot, feature.featureId);

  // Role (M2.15): desconhecido → generic + evento, nunca falha.
  const roles = (deps.loadRoles ?? loadRoleRegistry)(feature.repoPath);
  let role = roles.get(task.role ?? GENERIC_ROLE_ID);
  if (!role) {
    await emitEvent(deps.events, deps.logger, {
      type: "task.unknown_role",
      featureId: feature.featureId,
      taskId,
      payload: { role: task.role },
    });
    role = roles.get(GENERIC_ROLE_ID);
  }
  if (!role) throw new Error("RoleRegistry sem o role generic");

  // Workspace (M2.2).
  const projectConfig = loadProjectConfig(feature.repoPath);
  const reliableReadOnly = deps.targets.every(
    (entry) => entry.harness.getCapabilities().supportsReadOnly,
  );
  const workspaceMode: WorkspaceMode = decideWorkspace({
    kind: task.kind,
    origin: task.origin,
    reliableReadOnly,
    projectDefaultMode: projectConfig.workspace?.defaultMode ?? "auto",
  });
  const env = deps.workerEnv?.(feature.repoPath);

  let cwd: string;
  let branch: string;
  if (workspaceMode === "isolated") {
    branch = task.branch ?? taskBranchName(feature.featureId, task.seq, task.title);
    const isNew = !task.worktreePath;
    cwd = await ensureTaskWorktree(
      feature.repoPath,
      feature.worktreesRoot,
      feature.featureId,
      taskId,
      branch,
    );
    if (isNew) {
      const prepared = await prepareWorktree(feature.repoPath, cwd, env);
      if (!prepared.passed) {
        await deps.tasks.updateStatus(taskId, "failed");
        return { status: "failed", reason: prepared.reason ?? "prepare falhou" };
      }
    }
  } else {
    // shared (read) e integration (corretiva de conflito) rodam na worktree de
    // integração — nunca no working tree principal do usuário (seção 4.1).
    cwd = integrationPath;
    branch =
      workspaceMode === "integration" ? (task.branch ?? integrationBranch) : integrationBranch;
  }
  await deps.tasks.update(taskId, { worktreePath: cwd, branch, workspaceMode, status: "running" });

  const dependencies = await Promise.all(
    task.dependencies.map(async (depId) => {
      const dep = await deps.tasks.getById(depId);
      return {
        title: dep?.title ?? depId,
        summary: dep?.summary ?? null,
        artifacts: dep?.artifacts ?? null,
      };
    }),
  );

  // M5.9: memória do projeto relevante para esta Task (descrição + arquivos).
  let memory: string | undefined;
  if (deps.memory) {
    try {
      memory = await deps.memory.retrieveForPrompt(
        feature.projectId,
        [task.title, task.description, ...(task.expectedPaths ?? [])].join("\n"),
      );
    } catch (error) {
      await emitEvent(deps.events, deps.logger, {
        type: "memory.retrieve_failed",
        projectId: feature.projectId,
        featureId: feature.featureId,
        taskId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const featureRow = await deps.features.getById(feature.featureId);
  const featurePreference = (featureRow?.executionPreference ?? null) as ExecutionPreference | null;
  const rolePreference = (role.executionPreference ?? null) as ExecutionPreference | null;

  // Handover persistido de uma execução anterior desta Task (restart/pausa).
  const previousHandovers = await deps.handovers.listByTask(taskId);
  let pendingHandoverId: string | undefined = previousHandovers.at(-1)?.id;
  let exclude: string[] = [];
  let lastFailureWasCapacity = false;

  // M5: o Jev classifica a Task uma vez por execução; a capacity policy
  // reaplica a capacidade atual a cada attempt (resolveExecutionTarget).
  let semantic: SemanticDecision | undefined;
  let semanticError: string | undefined;
  let semanticTried = false;
  const semanticFor = async (taskPreference: ExecutionPreference | null) => {
    const overridden = [taskPreference, featurePreference, rolePreference].some(
      (preference) => preference && preference.mode !== "auto",
    );
    if (overridden || !deps.taskRouter || semanticTried) return semantic;
    semanticTried = true;
    try {
      semantic = await deps.taskRouter.route(
        {
          task: {
            title: task.title,
            description: task.description,
            kind: task.kind,
            role: role.id,
            expectedPaths: task.expectedPaths ?? [],
            origin: task.origin,
          },
          project: { name: basename(feature.repoPath) },
          candidates: deps.targets.map((entry) => {
            const capabilities = entry.harness.getCapabilities();
            return {
              candidate: entry.candidate,
              capabilities: {
                readOnly: capabilities.supportsReadOnly,
                structuredOutput: capabilities.supportsOutputSchema,
              },
              capacity: capacityOf(entry.candidate.provider),
            };
          }),
        },
        control?.featureSignal() ?? new AbortController().signal,
      );
    } catch (error) {
      semanticError = error instanceof Error ? error.message : String(error);
      await emitEvent(deps.events, deps.logger, {
        type: "routing.semantic_failed",
        projectId: feature.projectId,
        featureId: feature.featureId,
        taskId,
        payload: { router: deps.taskRouter.id, error: semanticError.slice(0, 500) },
      });
    }
    return semantic;
  };

  for (let attemptsInRun = 0; ; attemptsInRun += 1) {
    if (attemptsInRun >= deps.maxAttemptsPerTask) {
      await deps.tasks.updateStatus(taskId, "failed");
      return { status: "failed", reason: `limite de ${deps.maxAttemptsPerTask} attempts atingido` };
    }
    if (control?.isCancelled()) {
      await deps.tasks.updateStatus(taskId, "cancelled");
      return { status: "cancelled", reason: "Feature cancelada" };
    }

    const current = await deps.tasks.getById(taskId);
    const taskPreference = (current?.executionPreference ?? null) as ExecutionPreference | null;

    // M7: resposta a uma pergunta deste worker ainda não usada → retoma a
    // mesma sessão, no mesmo target, se ele estiver utilizável.
    const pendingAnswer = await pendingAnswerFor(deps, taskId);
    let resumeEntry: ExecutionTargetEntry | undefined;
    if (pendingAnswer?.payload.sessionId) {
      const candidate = findTarget(deps.targets, pendingAnswer.payload.targetId);
      const availability = candidate
        ? capacityOf(candidate.candidate.provider).availability
        : "exhausted";
      if (
        candidate?.harness.resume &&
        availability !== "exhausted" &&
        availability !== "degraded"
      ) {
        resumeEntry = candidate;
      }
    }

    const semanticDecision = resumeEntry ? undefined : await semanticFor(taskPreference);
    const resolve = (excluded: string[]) =>
      resolveExecutionTarget({
        candidates: candidatesOf(deps.targets),
        capacity: capacityOf,
        taskPreference,
        featurePreference,
        rolePreference,
        exclude: excluded,
        ...(semanticDecision ? { semantic: semanticDecision } : {}),
        ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
      });
    let resolved: ResolveResult = resumeEntry
      ? {
          kind: "target",
          target: resumeEntry.candidate,
          resolutionSource: "resume",
          reason: "retomada da sessão do worker com a resposta à pergunta",
        }
      : resolve(exclude);
    // Exclusão vem de crash/timeout (problema da Task). Se esvaziou as opções,
    // tentar de novo no mesmo target é melhor do que pausar por capacidade.
    if (resolved.kind === "no_capacity" && exclude.length > 0) {
      resolved = resolve([]);
    }
    await deps.routingDecisions.insert({
      id: randomUUID(),
      taskId,
      router:
        resolved.kind === "target" && resolved.resolutionSource === "jev"
          ? (semanticDecision?.router ?? "jev")
          : resolved.kind === "target" && resolved.resolutionSource !== "rule_router"
            ? "override"
            : "rule",
      resolutionSource: resolved.kind === "target" ? resolved.resolutionSource : resolved.kind,
      input: {
        taskPreference,
        featurePreference,
        rolePreference,
        exclude,
        capacity: candidatesOf(deps.targets).map((candidate) => capacityOf(candidate.provider)),
      },
      output: {
        kind: resolved.kind,
        reason: resolved.reason,
        ...("route" in resolved && resolved.route ? { considered: resolved.route.considered } : {}),
        // M5.5 RoutingAudit: o que o Jev disse e o que a política fez com isso.
        ...(semanticDecision ? { semantic: semanticDecision } : {}),
        ...(semanticError ? { semanticError } : {}),
        ...(resolved.kind === "target" && resolved.policy
          ? {
              overriddenByPolicy: resolved.policy.overriddenByPolicy,
              suggested: resolved.policy.suggested,
            }
          : {}),
      },
      finalTarget: resolved.kind === "target" ? resolved.target : null,
    });

    if (resolved.kind === "needs_human") {
      await deps.tasks.updateStatus(taskId, "needs_human");
      return { status: "needs_human", reason: resolved.reason };
    }
    if (resolved.kind === "no_capacity") {
      await deps.tasks.updateStatus(taskId, "retrying");
      return { status: "paused_capacity", reason: resolved.reason };
    }
    if (
      lastFailureWasCapacity &&
      capacityOf(resolved.target.provider).availability === "degraded"
    ) {
      await deps.tasks.updateStatus(taskId, "retrying");
      return {
        status: "paused_capacity",
        reason: "só restaram providers degradados depois de uma falha de capacidade",
      };
    }

    const entry = findTarget(deps.targets, resolved.target.targetId);
    if (!entry)
      throw new Error(`runTask: target "${resolved.target.targetId}" sem harness registrado`);

    const handover = pendingHandoverId
      ? ((await deps.handovers.getById(pendingHandoverId))?.payload as
          | TaskHandoverPayload
          | undefined)
      : undefined;

    const release = deps.slots ? await deps.slots.acquire(entry.harness.provider) : () => undefined;
    const previousAttempts = await deps.taskAttempts.listByTask(taskId);
    const n = previousAttempts.length + 1;
    const attemptId = randomUUID();
    const logPath = (
      deps.attemptLogPath ??
      ((id: string) => join(homedir(), ".apo", "logs", "attempts", `${id}.log`))
    )(attemptId);
    const resultPath = join(
      deps.runsRoot ?? join(homedir(), ".apo", "runs"),
      attemptId,
      "result.json",
    );

    let result: Awaited<ReturnType<typeof entry.harness.execute>>;
    let signal: AbortSignal;
    let attemptStartedAt = new Date();
    try {
      await deps.taskAttempts.create({
        id: attemptId,
        taskId,
        n,
        provider: entry.harness.provider,
        harness: entry.harness.id,
        targetId: entry.candidate.targetId,
        resolutionSource: resolved.resolutionSource,
        ...(pendingHandoverId ? { handoverId: pendingHandoverId } : {}),
        ...(entry.candidate.model !== undefined ? { model: entry.candidate.model } : {}),
        logPath,
        status: "working",
      });
      await emitEvent(deps.events, deps.logger, {
        type: "attempt.started",
        projectId: feature.projectId,
        featureId: feature.featureId,
        taskId,
        payload: {
          attemptId,
          n,
          target: entry.candidate.targetId,
          role: role.id,
          workspaceMode,
          reason: resolved.reason,
        },
      });

      // Task corretiva: reproduz o conflito na integração antes de cada attempt (M2.8).
      if (workspaceMode === "integration" && task.branch) {
        await startConflictMerge(cwd, task.branch);
      }

      signal = control?.newAttempt(taskId) ?? new AbortController().signal;
      attemptStartedAt = new Date();
      // M7: o worker ainda pode perguntar? (abaixo do teto da Task)
      const canAsk =
        (await questionsAskedBy(deps, taskId)) < questionLimits(feature.repoPath).maxPerTask;
      const answered: AnsweredQuestion | undefined = pendingAnswer
        ? {
            question: pendingAnswer.payload.question,
            answer: pendingAnswer.resolution.answer,
            answeredBy: pendingAnswer.resolution.answeredBy,
            rationale: pendingAnswer.resolution.rationale,
          }
        : undefined;
      if (pendingAnswer) await markAnswerConsumed(deps, pendingAnswer.id);
      const resumeSessionId =
        resumeEntry && entry === resumeEntry ? pendingAnswer?.payload.sessionId : undefined;
      deps.capacity.workerStarted(entry.harness.provider);
      try {
        const prompt =
          resumeSessionId && answered
            ? buildResumePrompt(answered, resultPath, canAsk)
            : buildWorkerPrompt({
                role,
                featureObjective: feature.objective,
                task: { title: task.title, description: task.description, kind: task.kind },
                dependencies,
                ...(handover ? { handover } : {}),
                ...(memory ? { memory } : {}),
                ...(answered ? { answered } : {}),
                resultPath,
                canAsk,
              });
        const run = (input: AgentExecutionInput) =>
          resumeSessionId && entry.harness.resume
            ? entry.harness.resume({ ...input, sessionId: resumeSessionId }, signal)
            : entry.harness.execute(input, signal);
        result = await run({
          prompt,
          cwd,
          mode: workspaceMode === "shared" ? "read-only" : "workspace-write",
          networkAccess: false,
          timeoutMs: deps.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
          stallTimeoutMs: deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
          logPath,
          env: { ...(env ?? {}), APO_RESULT_PATH: resultPath },
          extraWritableDirs: [dirname(resultPath)],
          // M6.8: PID do CLI em runs/<attempt>/worker.pid — o boot do daemon
          // mata o que sobrou de uma execução anterior que caiu no meio.
          onSpawn: (pid: number) => {
            try {
              mkdirSync(dirname(resultPath), { recursive: true });
              writeFileSync(join(dirname(resultPath), "worker.pid"), String(pid));
            } catch {
              // Só serve para limpeza no boot; nunca impede o attempt.
            }
          },
          ...(entry.candidate.model !== undefined ? { model: entry.candidate.model } : {}),
        });
      } finally {
        deps.capacity.workerFinished(entry.harness.provider);
        await rm(join(dirname(resultPath), "worker.pid"), { force: true });
        control?.attemptFinished(taskId);
      }
    } finally {
      release();
    }

    await deps.taskAttempts.update(attemptId, {
      status: attemptStatusFor(result.failure),
      failureKind: result.failure?.kind ?? null,
      failureMessage: result.failure?.message.slice(0, 2_000) ?? null,
      endedAt: new Date(),
    });

    if (result.outcome === "success") {
      deps.capacity.recordSuccess(entry.harness.provider, attemptStartedAt);
      const report = await readWorkerReport(resultPath);
      if (report) {
        await deps.tasks.update(taskId, {
          ...(report.artifacts !== undefined ? { artifacts: report.artifacts } : {}),
          summary: report.summary ?? null,
        });
        for (const request of report.planChangeRequests ?? []) {
          await deps.agentMessages.create({
            id: randomUUID(),
            featureId: feature.featureId,
            fromTaskId: taskId,
            type: PLAN_CHANGE_REQUEST,
            payload: request,
          });
        }
      }

      // M7: o worker parou para perguntar. Muito acima do teto (ele foi
      // avisado que não podia mais perguntar e insistiu), a pergunta vira só
      // nota e a Task fecha normalmente — evita um ciclo pergunta/resposta sem fim.
      const askedSoFar = await questionsAskedBy(deps, taskId);
      const hardLimit = questionLimits(feature.repoPath).maxPerTask + 1;
      if (report?.question && askedSoFar >= hardLimit) {
        await emitEvent(deps.events, deps.logger, {
          type: "task.question_ignored",
          projectId: feature.projectId,
          featureId: feature.featureId,
          taskId,
          payload: {
            question: report.question.question,
            reason: `teto de ${hardLimit - 1} perguntas por Task`,
          },
        });
      } else if (report?.question) {
        const payload: QuestionPayload = {
          ...report.question,
          taskId,
          taskTitle: task.title,
          role: role.id,
          attemptId,
          targetId: entry.candidate.targetId,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        };
        const question = await askQuestion(deps, {
          featureId: feature.featureId,
          projectId: feature.projectId,
          payload,
        });
        const freshFeature = await deps.features.getById(feature.featureId);
        const mode = await effectiveQuestionMode(deps, freshFeature ?? {}, feature.repoPath);
        const overLimit =
          (await questionsAskedBy(deps, taskId)) > questionLimits(feature.repoPath).maxPerTask;
        if (question && (mode !== "ask_human" || overLimit)) {
          const judge = pickJudge(deps);
          const resolvedByLead =
            judge &&
            (await resolveWithLead(
              deps,
              {
                questionId: question.id,
                projectId: feature.projectId,
                objective: feature.objective,
                payload,
                reason: overLimit ? "limit" : mode === "auto" ? "auto" : "lead_first",
                runner: judge.runner,
                cwd,
                timeoutMs: deps.judgeTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
                ...(mode === "lead_first" && !overLimit
                  ? { minConfidence: LEAD_FIRST_MIN_CONFIDENCE }
                  : {}),
              },
              control?.featureSignal() ?? new AbortController().signal,
            ));
          if (resolvedByLead) {
            // Responder não gasta attempt: a rodada seguinte só retoma a sessão.
            attemptsInRun -= 1;
            continue;
          }
        }
        await deps.tasks.transitionIf(taskId, ["running"], "awaiting_answer");
        return { status: "awaiting_answer", reason: payload.question };
      }

      if (task.kind === "write") {
        // Git é responsabilidade da infraestrutura, não do agente (regra 10).
        await commitIfDirty(cwd, `apo: ${task.title.slice(0, 72)}`);
        if (workspaceMode === "integration") {
          if (await hasConflictMarkers(cwd)) {
            await abortMergeIfAny(cwd);
            await deps.tasks.updateStatus(taskId, "failed");
            return {
              status: "failed",
              reason: "conflito não resolvido: marcadores de conflito restantes",
            };
          }
        } else if (!(await hasNewCommits(cwd, integrationBranch))) {
          // Num DAG é legítimo: o trabalho pode já ter vindo de uma dependência
          // (ex.: a Task de testes depois de uma que já escreveu os testes).
          // "Feature que não fez nada" é barrada no verify da integração.
          await deps.tasks.update(taskId, { actualChangedPaths: [] });
          await emitEvent(deps.events, deps.logger, {
            type: "task.no_changes",
            projectId: feature.projectId,
            featureId: feature.featureId,
            taskId,
            ...(report?.summary ? { payload: { summary: report.summary } } : {}),
          });
        } else {
          await deps.tasks.update(taskId, {
            actualChangedPaths: await changedPathsSince(cwd, integrationBranch),
          });
        }
      }

      await deps.tasks.updateStatus(taskId, "completed");
      return { status: "completed" };
    }

    if (workspaceMode === "integration") {
      await abortMergeIfAny(cwd);
    }

    const failure = result.failure ?? { kind: "crash" as const, message: "falha sem detalhe" };
    const abortReason = abortReasonOf(signal);
    const failures = [
      ...previousAttempts
        .filter((attempt) => attempt.failureMessage)
        .map((attempt) => `${attempt.targetId ?? attempt.harness}: ${attempt.failureMessage}`),
      `${entry.candidate.targetId}: ${failure.message}`,
    ];
    const persistHandover = async () => {
      const payload = await buildHandover({
        taskId,
        objective: `${task.title}\n\n${task.description}`,
        attemptNumber: n,
        worktreePath: cwd,
        baseRef: integrationBranch,
        failures,
        commitWip: workspaceMode === "isolated",
        ...(result.finalMessage !== undefined ? { lastAgentMessage: result.finalMessage } : {}),
      });
      const id = randomUUID();
      await deps.handovers.create({ id, taskId, fromAttemptId: attemptId, payload });
      return id;
    };

    // Reroute manual (M3.10): a nova preferência vira override da Task.
    if (failure.kind === "cancelled" && abortReason?.type === "reroute") {
      await deps.tasks.update(taskId, {
        executionPreference: abortReason.preference,
        status: "retrying",
      });
      pendingHandoverId = await persistHandover();
      await emitEvent(deps.events, deps.logger, {
        type: "task.rerouted",
        projectId: feature.projectId,
        featureId: feature.featureId,
        taskId,
        payload: {
          fromTarget: entry.candidate.targetId,
          preference: abortReason.preference,
          handoverId: pendingHandoverId,
        },
      });
      exclude = [];
      lastFailureWasCapacity = false;
      continue;
    }

    if (failure.kind === "cancelled") {
      await deps.tasks.updateStatus(taskId, "cancelled");
      return { status: "cancelled", reason: failure.message };
    }

    deps.capacity.recordFailure(entry.harness.provider, failure);
    const isCapacity = CAPACITY_FAILURES.has(failure.kind);

    if (!RETRYABLE_FAILURES.has(failure.kind) || attemptsInRun + 1 >= deps.maxAttemptsPerTask) {
      await deps.tasks.updateStatus(taskId, "failed");
      return { status: "failed", reason: failure.message };
    }

    // Failover (M3.8): handover → Task retrying → novo attempt no mesmo workspace.
    await deps.tasks.updateStatus(taskId, "retrying");
    pendingHandoverId = await persistHandover();
    await emitEvent(deps.events, deps.logger, {
      type: "task.failover",
      projectId: feature.projectId,
      featureId: feature.featureId,
      taskId,
      payload: {
        fromTarget: entry.candidate.targetId,
        failureKind: failure.kind,
        handoverId: pendingHandoverId,
      },
    });
    exclude = isCapacity ? exclude : [...exclude, entry.candidate.targetId];
    lastFailureWasCapacity = isCapacity;
  }
}
