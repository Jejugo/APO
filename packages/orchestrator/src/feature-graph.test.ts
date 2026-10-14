// Integração do ApoNativeEngine com FakeHarness contra o Postgres do
// docker/compose.yaml — requer `pnpm db:up && pnpm db:migrate`.
// M1: completed/failed/cancelled, verify, recovery idempotente.
// M2: DAG em ondas paralelas, dependente enxerga o código das dependências,
//     artefatos, conflito → Task corretiva, role no prompt, Task read em shared,
//     duas Features ao mesmo tempo.
// M3: failover entre providers, paused_capacity, forced indisponível, reroute.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AgentMessageRepository,
  type Db,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  SettingsRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import type { ExecutionPreference, ProviderId } from "@apo/domain";
import { type AgentExecutionInput, FakeHarness, type FakeHarnessStep } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import { CapacityMonitor } from "@apo/routing";
import { type BaseCheckpointSaver, Command, MemorySaver } from "@langchain/langgraph";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunnerImpl } from "./agent-runner.js";
import { AttemptControl } from "./attempt-control.js";
import type { PullRequestCreator, PullRequestInput } from "./delivery.js";
import {
  type ApprovalDecision,
  FEATURE_GRAPH_RECURSION_LIMIT,
  type FeatureGraphDeps,
  buildFeatureGraph,
} from "./feature-graph.js";
import type { ExecutionTargetEntry } from "./harness-registry.js";
import type { FeaturePlan } from "./plan.js";
import { WORKER_CONTRACT } from "./prompt-builder.js";
import {
  type QuestionPayload,
  answerQuestion,
  interpretHumanAnswer,
  resolveWithLead,
} from "./questions.js";
import { replanFeature } from "./replan.js";
import { WorkerSlots } from "./worker-slots.js";

// Integração de verdade (git + Postgres por teste). Com o `pnpm check` rodando
// todos os pacotes em paralelo, o padrão de 5 s do Vitest falhava de vez em
// quando sem nenhum defeito real.
vi.setConfig({ testTimeout: 30_000 });

type Responder = (input: AgentExecutionInput) => FakeHarnessStep | undefined;

/** Lead e Reviewer aprovam tudo, a menos que o teste troque o `judge`. */
const approvingJudge: Responder = (input) => {
  if (input.prompt.includes("Verifique se a mudança")) {
    return {
      succeed: {
        structuredOutput: { requirements: [{ requirement: "o objetivo", satisfied: true }] },
      },
    };
  }
  if (input.prompt.includes("Você é o Reviewer")) {
    return { succeed: { structuredOutput: { findings: [] } } };
  }
  if (input.prompt.includes("acabou de ser concluída")) {
    return {
      succeed: {
        structuredOutput: {
          memories: [
            {
              kind: "decision",
              title: "decisão de teste",
              content: "registrada pelo MemoryWriter",
            },
          ],
        },
      },
    };
  }
  if (input.prompt.includes("pediu uma mudança no plano")) {
    return { succeed: { structuredOutput: { decision: "reject", reason: "fora do escopo" } } };
  }
  return undefined;
};

/**
 * Workers seguem o `script` (lista em ordem, ou escolha por input). Chamadas
 * com saída estruturada (Lead/Reviewer, M4) vão para o `judge`, sem consumir
 * passos do script.
 */
function fakeTarget(
  targetId: string,
  provider: ProviderId,
  script: FakeHarnessStep[] | Responder,
  judge: Responder = approvingJudge,
): ExecutionTargetEntry {
  let cursor = 0;
  const worker: Responder = Array.isArray(script)
    ? () => script[cursor++] ?? { succeed: {} }
    : script;
  return {
    candidate: { targetId, provider, harness: "fake" },
    harness: new FakeHarness({
      label: targetId,
      provider,
      respond: (input) => (input.outputSchema ? judge(input) : worker(input)),
    }),
  };
}

/** Escolhe o passo pela Task (o prompt traz "Task: <título>"). */
function byTitle(steps: Record<string, FakeHarnessStep>) {
  return (input: AgentExecutionInput) => {
    // Linha inteira: "Task: ui" não pode casar com "Task: ui com filtro".
    // Chave terminada em "*" casa por prefixo.
    const lines = input.prompt.split("\n");
    const title = Object.keys(steps).find((key) =>
      key.endsWith("*")
        ? lines.some((line) => line.startsWith(`Task: ${key.slice(0, -1)}`))
        : lines.includes(`Task: ${key}`),
    );
    return title ? steps[title] : undefined;
  };
}

function planOf(
  ...tasks: Array<Partial<FeaturePlan["tasks"][number]> & { key: string; title: string }>
): FeaturePlan {
  return {
    tasks: tasks.map((task) => ({
      description: task.title,
      kind: "write" as const,
      role: "generic",
      expectedPaths: [],
      dependsOn: [],
      ...task,
    })),
  };
}

class FakePullRequests implements PullRequestCreator {
  readonly created: PullRequestInput[] = [];
  async create(input: PullRequestInput) {
    this.created.push(input);
    return { url: `https://example.test/pr/${this.created.length}` };
  }
}

describe("ApoNativeEngine — integração com FakeHarness", () => {
  let db: Db;
  let repoPath: string;
  let worktreesRoot: string;
  let repos: {
    projects: ProjectRepository;
    features: FeatureRepository;
    tasks: TaskRepository;
    taskAttempts: TaskAttemptRepository;
    events: EventRepository;
    routingDecisions: RoutingDecisionRepository;
    handovers: HandoverRepository;
    qualityResults: QualityResultRepository;
    agentMessages: AgentMessageRepository;
    settings: SettingsRepository;
  };

  beforeAll(() => {
    db = createDb();
    repos = {
      projects: new ProjectRepository(db),
      features: new FeatureRepository(db),
      tasks: new TaskRepository(db),
      taskAttempts: new TaskAttemptRepository(db),
      events: new EventRepository(db),
      routingDecisions: new RoutingDecisionRepository(db),
      handovers: new HandoverRepository(db),
      qualityResults: new QualityResultRepository(db),
      agentMessages: new AgentMessageRepository(db),
      settings: new SettingsRepository(db),
    };
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    // O modo global das perguntas fica no banco: um teste que estoura o tempo
    // não pode deixar "auto" ligado para os seguintes.
    await repos.settings.delete("questions.mode");
    repoPath = await mkdtemp(join(tmpdir(), "apo-engine-repo-"));
    worktreesRoot = await mkdtemp(join(tmpdir(), "apo-engine-worktrees-"));
    await execa("git", ["init", "-b", "main"], { cwd: repoPath });
    await execa("git", ["config", "user.email", "apo-test@example.com"], { cwd: repoPath });
    await execa("git", ["config", "user.name", "apo test"], { cwd: repoPath });
    await execa("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repoPath });
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(worktreesRoot, { recursive: true, force: true });
  });

  async function setup(options: {
    targets: ExecutionTargetEntry[];
    capacity?: CapacityMonitor;
    featurePreference?: ExecutionPreference;
    plan?: FeaturePlan;
    slots?: WorkerSlots;
    intent?: "feature" | "bugfix" | "document";
  }) {
    let project = await repos.projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const objective = `objetivo ${randomUUID().slice(0, 8)}`;
    const feature = await repos.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective,
      intent: options.intent ?? "feature",
      ...(options.featurePreference ? { executionPreference: options.featurePreference } : {}),
      ...(options.plan ? { plan: options.plan } : {}),
    });
    if (!feature) throw new Error("feature não criada");
    project = undefined as never;

    const capacity = options.capacity ?? new CapacityMonitor();
    const prs = new FakePullRequests();
    const deps: FeatureGraphDeps = {
      logger: createLogger({}),
      features: repos.features,
      tasks: repos.tasks,
      taskAttempts: repos.taskAttempts,
      events: repos.events,
      routingDecisions: repos.routingDecisions,
      handovers: repos.handovers,
      targets: options.targets,
      capacity,
      maxAttemptsPerTask: 3,
      qualityResults: repos.qualityResults,
      agentMessages: repos.agentMessages,
      settings: repos.settings,
      pullRequests: prs,
      judgeTimeoutMs: 10_000,
      attemptLogPath: (attemptId) => join(worktreesRoot, "logs", `${attemptId}.log`),
      runsRoot: join(worktreesRoot, "runs"),
      reviewLogPath: (id, iteration) =>
        join(worktreesRoot, "logs", `${id}-${iteration}.review.log`),
      ...(options.slots ? { slots: options.slots } : {}),
    };
    const input = {
      featureId: feature.id,
      projectId: feature.projectId,
      repoPath,
      defaultBranch: "main",
      objective,
      worktreesRoot,
    };
    const integrationPath = join(worktreesRoot, feature.id, "integration");
    return { feature, deps, input, capacity, integrationPath, prs };
  }

  /**
   * Roda até um status terminal. Se parar em awaiting_approval (interrupt do
   * M4.8), responde com `approvals` em ordem; acabou a lista → aprova.
   */
  async function run(
    deps: FeatureGraphDeps,
    input: Awaited<ReturnType<typeof setup>>["input"],
    control?: AttemptControl,
    options: { approvals?: ApprovalDecision[]; checkpointer?: BaseCheckpointSaver } = {},
  ) {
    const graph = buildFeatureGraph(deps, options.checkpointer ?? new MemorySaver());
    const config = {
      recursionLimit: FEATURE_GRAPH_RECURSION_LIMIT,
      configurable: { thread_id: input.featureId, ...(control ? { attemptControl: control } : {}) },
    };
    const approvals = [...(options.approvals ?? [])];
    await graph.invoke(input, config);
    for (let round = 0; round < 10; round++) {
      const feature = await repos.features.getById(input.featureId);
      if (feature?.status !== "awaiting_approval") return;
      const decision: ApprovalDecision = approvals.shift() ?? { action: "approve" };
      await graph.invoke(new Command({ resume: decision }), config);
    }
  }

  async function finalState(featureId: string) {
    const feature = await repos.features.getById(featureId);
    const tasks = (await repos.tasks.listByFeature(featureId)).sort((a, b) => a.seq - b.seq);
    const attempts = (
      await Promise.all(tasks.map((task) => repos.taskAttempts.listByTask(task.id)))
    ).flat();
    return { feature, tasks, attempts };
  }

  // --- M1 ------------------------------------------------------------------

  it("sem plano salvo: uma Task só, integrada na branch de integração", async () => {
    const { feature, deps, input, integrationPath } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "novo.txt", content: "oi" }, commit: "feat: novo" },
        ]),
      ],
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks).toHaveLength(1);
    expect(existsSync(join(integrationPath, "novo.txt"))).toBe(true);
  });

  it("crash repetido no único target esgota os attempts e falha", async () => {
    const crash: FakeHarnessStep = { fail: { kind: "crash" } };
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [crash, crash, crash])],
    });
    await run(deps, input);

    const { feature: done, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("failed");
    expect(attempts).toHaveLength(3);
  });

  it("harness sucede mas não gera commit → Feature failed", async () => {
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [{ succeed: {} }])],
    });
    await run(deps, input);
    expect((await finalState(feature.id)).feature?.status).toBe("failed");
  });

  // Achado do E2E real do M2: a Task de testes encontrou os testes já escritos
  // pela dependência. Sem mudanças ≠ falha; o verify da integração barra o vazio.
  it("Task de escrita sem mudanças, com dependência que já fez o trabalho → completed com aviso", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          byTitle({
            implementar: { writeFile: { path: "impl.txt", content: "x" }, commit: "feat: impl" },
            testes: { report: { summary: "testes já existiam" } },
          }),
        ),
      ],
      plan: planOf(
        { key: "t1", title: "implementar" },
        { key: "t2", title: "testes", dependsOn: ["t1"] },
      ),
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks[1]?.status).toBe("completed");
    expect(tasks[1]?.actualChangedPaths).toEqual([]);
    const events = await repos.events.listByFeature(feature.id);
    expect(events.some((event) => event.type === "task.no_changes")).toBe(true);
  });

  // Regressão do M1: cancelamento por `configurable`, nunca pelo `signal` do invoke().
  it("cancelamento externo interrompe o harness e o graph grava 'cancelled'", async () => {
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [{ delayMs: 5_000, succeed: {} }])],
    });
    const control = new AttemptControl();
    setTimeout(() => control.cancel(), 100);
    await run(deps, input, control);
    expect((await finalState(feature.id)).feature?.status).toBe("cancelled");
  });

  it("recovery (M1.13): re-invocar o graph não duplica Tasks nem re-executa o worker", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: feature.id } };
    await buildFeatureGraph(deps, checkpointer).invoke(input, config);
    await buildFeatureGraph(deps, checkpointer).invoke(input, config);

    const { tasks, attempts } = await finalState(feature.id);
    expect(tasks).toHaveLength(1);
    expect(attempts).toHaveLength(1);
  });

  // --- M2 ------------------------------------------------------------------

  it("DAG: 3 Tasks em paralelo + 1 dependente que enxerga o código e os artefatos das outras", async () => {
    const harness = fakeTarget(
      "fake-a",
      "anthropic",
      byTitle({
        backend: {
          delayMs: 300,
          writeFile: { path: "backend.txt", content: "api" },
          commit: "feat: backend",
          report: { summary: "API criada", artifacts: { endpoint: "GET /favoritos" } },
        },
        frontend: {
          delayMs: 300,
          writeFile: { path: "frontend.txt", content: "ui" },
          commit: "feat: frontend",
        },
        docs: {
          delayMs: 300,
          writeFile: { path: "docs.txt", content: "doc" },
          commit: "feat: docs",
        },
        integracao: { writeFile: { path: "e2e.txt", content: "ok" }, commit: "feat: e2e" },
      }),
    );
    const { feature, deps, input, integrationPath } = await setup({
      targets: [harness],
      plan: planOf(
        { key: "t1", title: "backend" },
        { key: "t2", title: "frontend" },
        { key: "t3", title: "docs" },
        { key: "t4", title: "integracao", dependsOn: ["t1", "t2", "t3"] },
      ),
    });
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks.map((task) => task.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);

    // Paralelismo: as três primeiras começaram antes de qualquer uma terminar.
    const firstWave = attempts.filter((attempt) =>
      tasks.slice(0, 3).some((task) => task.id === attempt.taskId),
    );
    const latestStart = Math.max(...firstWave.map((attempt) => attempt.startedAt.getTime()));
    const earliestEnd = Math.min(...firstWave.map((attempt) => attempt.endedAt?.getTime() ?? 0));
    expect(latestStart).toBeLessThan(earliestEnd);

    // A dependente nasceu do HEAD de integração (M2.7) e recebeu os artefatos (M2.9).
    const dependentWorktree = tasks[3]?.worktreePath ?? "";
    for (const file of ["backend.txt", "frontend.txt", "docs.txt"]) {
      expect(existsSync(join(dependentWorktree, file))).toBe(true);
    }
    const prompts = (harness.harness as FakeHarness).receivedPrompts;
    const dependentPrompt = prompts.find((prompt) => prompt.includes("Task: integracao")) ?? "";
    expect(dependentPrompt).toContain("GET /favoritos");
    expect(dependentPrompt).toContain("API criada");

    for (const file of ["backend.txt", "frontend.txt", "docs.txt", "e2e.txt"]) {
      expect(existsSync(join(integrationPath, file))).toBe(true);
    }
    expect(tasks[0]?.artifacts).toEqual({ endpoint: "GET /favoritos" });
    expect(tasks[0]?.actualChangedPaths).toEqual(["backend.txt"]);
  });

  it("conflito na integração vira Task corretiva, que resolve e conclui a Feature", async () => {
    const { feature, deps, input, integrationPath } = await setup({
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          byTitle({
            "versao A": {
              writeFile: { path: "config.txt", content: "valor=A\n" },
              commit: "feat: A",
            },
            "versao B": {
              writeFile: { path: "config.txt", content: "valor=B\n" },
              commit: "feat: B",
            },
            "Resolver conflito*": { writeFile: { path: "config.txt", content: "valor=A+B\n" } },
          }),
        ),
      ],
      plan: planOf({ key: "t1", title: "versao A" }, { key: "t2", title: "versao B" }),
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const corrective = tasks.find((task) => task.origin === "conflict");
    expect(corrective?.status).toBe("completed");
    expect(corrective?.workspaceMode).toBe("integration");
    expect(readFileSync(join(integrationPath, "config.txt"), "utf8")).toBe("valor=A+B\n");
  });

  it("PromptBuilder: systemPrompt do role → contrato do worker → contexto da Task, nessa ordem", async () => {
    const harness = fakeTarget("fake-a", "anthropic", [
      { writeFile: { path: "ui.txt", content: "x" }, commit: "feat: ui" },
    ]);
    const { feature, deps, input } = await setup({
      targets: [harness],
      plan: planOf({ key: "t1", title: "tela de favoritos", role: "frontend-developer" }),
    });
    await run(deps, input);

    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const prompt = (harness.harness as FakeHarness).receivedPrompts[0] ?? "";
    const roleAt = prompt.indexOf("Você é um desenvolvedor frontend");
    const contractAt = prompt.indexOf(WORKER_CONTRACT);
    const taskAt = prompt.indexOf("Task: tela de favoritos");
    expect(roleAt).toBe(0);
    expect(roleAt).toBeLessThan(contractAt);
    expect(contractAt).toBeLessThan(taskAt);
  });

  it("role desconhecido cai em generic sem falhar e gera evento", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
      plan: planOf({ key: "t1", title: "algo", role: "role-que-nao-existe" }),
    });
    await run(deps, input);

    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const events = await repos.events.listByFeature(feature.id);
    expect(events.some((event) => event.type === "task.unknown_role")).toBe(true);
  });

  it("Task read roda em shared (worktree de integração, read-only), sem worktree própria", async () => {
    const harness = fakeTarget(
      "fake-a",
      "anthropic",
      byTitle({
        analise: { report: { summary: "análise feita" } },
        implementar: { writeFile: { path: "impl.txt", content: "x" }, commit: "feat: impl" },
      }),
    );
    const { feature, deps, input, integrationPath } = await setup({
      targets: [harness],
      plan: planOf(
        { key: "t1", title: "analise", kind: "read" },
        { key: "t2", title: "implementar", dependsOn: ["t1"] },
      ),
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks[0]?.workspaceMode).toBe("shared");
    expect(tasks[0]?.worktreePath).toBe(integrationPath);
    expect(existsSync(join(worktreesRoot, feature.id, tasks[0]?.id ?? ""))).toBe(false);
    expect(tasks[0]?.summary).toBe("análise feita");
  });

  it("M2.14: duas Features no mesmo Project ao mesmo tempo, sem colisão", async () => {
    const step = (name: string): FakeHarnessStep => ({
      delayMs: 200,
      writeFile: { path: `${name}.txt`, content: name },
      commit: `feat: ${name}`,
    });
    const one = await setup({
      targets: [fakeTarget("fake-a", "anthropic", byTitle({ um: step("um") }))],
      plan: planOf({ key: "t1", title: "um" }),
    });
    const two = await setup({
      targets: [fakeTarget("fake-b", "openai", byTitle({ dois: step("dois") }))],
      plan: planOf({ key: "t1", title: "dois" }),
    });
    await Promise.all([run(one.deps, one.input), run(two.deps, two.input)]);

    expect((await finalState(one.feature.id)).feature?.status).toBe("completed");
    expect((await finalState(two.feature.id)).feature?.status).toBe("completed");
    expect(existsSync(join(one.integrationPath, "um.txt"))).toBe(true);
    expect(existsSync(join(one.integrationPath, "dois.txt"))).toBe(false);
    expect(existsSync(join(two.integrationPath, "dois.txt"))).toBe(true);
  });

  it("WorkerSlots: com maxGlobal=1, as Tasks de uma onda não rodam ao mesmo tempo", async () => {
    const step = (name: string): FakeHarnessStep => ({
      delayMs: 150,
      writeFile: { path: `${name}.txt`, content: name },
      commit: `feat: ${name}`,
    });
    const { feature, deps, input } = await setup({
      slots: new WorkerSlots(1, 1),
      targets: [fakeTarget("fake-a", "anthropic", byTitle({ x: step("x"), y: step("y") }))],
      plan: planOf({ key: "t1", title: "x" }, { key: "t2", title: "y" }),
    });
    await run(deps, input);

    const { feature: done, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const [a, b] = [...attempts].sort((p, q) => p.startedAt.getTime() - q.startedAt.getTime());
    expect(b?.startedAt.getTime()).toBeGreaterThanOrEqual(
      a?.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  // --- M3 ------------------------------------------------------------------

  it("failover: rate limit no meio → handover → outro provider conclui, preservando o trabalho", async () => {
    const { feature, deps, input, capacity, integrationPath } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          {
            writeFile: { path: "parte-a.txt", content: "feito por A" },
            commit: "feat: parte A",
            fail: { kind: "rate_limited", resetInMs: 60_000 },
          },
        ]),
        fakeTarget("fake-b", "openai", [
          { writeFile: { path: "parte-b.txt", content: "feito por B" }, commit: "feat: parte B" },
        ]),
      ],
    });
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(attempts.map((attempt) => [attempt.targetId, attempt.status])).toEqual([
      ["fake-a", "rate_limited"],
      ["fake-b", "completed"],
    ]);
    expect(attempts[1]?.handoverId).toBeTruthy();
    expect(existsSync(join(integrationPath, "parte-a.txt"))).toBe(true);
    expect(existsSync(join(integrationPath, "parte-b.txt"))).toBe(true);
    expect(capacity.get("anthropic").availability).toBe("degraded");

    const handover = await repos.handovers.getById(attempts[1]?.handoverId ?? "");
    expect((handover?.payload as { changedFiles: string[] }).changedFiles).toContain("parte-a.txt");
    expect(await repos.routingDecisions.listByTask(tasks[0]?.id ?? "")).toHaveLength(2);
  });

  it("limite de uso não gasta o orçamento de tentativas: sem providers livres, pausa em vez de falhar", async () => {
    // Orçamento de 3 tentativas: duas falhas de capacidade + uma falha comum já
    // bateriam no limite, e antes a última falha de limite virava `failed`.
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { fail: { kind: "rate_limited", resetInMs: 3_600_000 } },
        ]),
        fakeTarget("fake-b", "openai", [{ fail: { kind: "crash" } }]),
        fakeTarget("fake-c", "google", [{ fail: { kind: "rate_limited", resetInMs: 3_600_000 } }]),
      ],
    });
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("paused_capacity");
    expect(tasks[0]?.status).toBe("retrying");
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "rate_limited",
      "failed",
      "rate_limited",
    ]);
  });

  it("todos os providers esgotados → paused_capacity, sem rodar nenhum worker", async () => {
    const capacity = new CapacityMonitor();
    capacity.recordFailure("anthropic", { kind: "quota_exhausted", message: "limite" });
    capacity.recordFailure("openai", { kind: "quota_exhausted", message: "limite" });
    const { feature, deps, input } = await setup({
      capacity,
      targets: [fakeTarget("fake-a", "anthropic", []), fakeTarget("fake-b", "openai", [])],
    });
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("paused_capacity");
    expect(tasks[0]?.status).toBe("retrying");
    expect(attempts).toHaveLength(0);
  });

  it("forced com o target esgotado → needs_human, sem trocar de provider", async () => {
    const capacity = new CapacityMonitor();
    capacity.recordFailure("openai", { kind: "quota_exhausted", message: "limite" });
    const { feature, deps, input } = await setup({
      capacity,
      featurePreference: { mode: "forced", provider: "openai" },
      targets: [fakeTarget("fake-a", "anthropic", []), fakeTarget("fake-b", "openai", [])],
    });
    await run(deps, input);

    const { feature: done, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("needs_human");
    expect(attempts).toHaveLength(0);
  });

  it("reroute manual: interrompe o attempt da Task e conclui no target pedido", async () => {
    const control = new AttemptControl();
    const { feature, deps, input, integrationPath } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", (attemptInput) => {
          // O cwd da Task isolada é <worktreesRoot>/<featureId>/<taskId>.
          const taskId = basename(attemptInput.cwd);
          setTimeout(() => control.reroute(taskId, { mode: "forced", provider: "openai" }), 100);
          return { delayMs: 5_000, succeed: {} };
        }),
        fakeTarget("fake-b", "openai", [
          { writeFile: { path: "b.txt", content: "b" }, commit: "feat: b" },
        ]),
      ],
    });
    await run(deps, input, control);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(attempts.map((attempt) => attempt.targetId)).toEqual(["fake-a", "fake-b"]);
    expect(tasks[0]?.executionPreference).toEqual({ mode: "forced", provider: "openai" });
    expect(existsSync(join(integrationPath, "b.txt"))).toBe(true);
  });
  // --- M4 ------------------------------------------------------------------

  function projectYaml(content: string) {
    mkdirSync(join(repoPath, ".apo"), { recursive: true });
    writeFileSync(join(repoPath, ".apo", "project.yaml"), content);
  }

  /** Reviewer devolve `rounds[i]` na i-ésima chamada (depois, lista vazia). */
  function reviewerRounds(
    ...rounds: Array<Array<{ severity: string; description: string; file?: string }>>
  ): Responder {
    let call = 0;
    return (input) => {
      if (input.prompt.includes("Você é o Reviewer")) {
        return { succeed: { structuredOutput: { findings: rounds[call++] ?? [] } } };
      }
      return approvingJudge(input);
    };
  }

  it("M4: gates + requisitos + review aprovados → awaiting_approval → approve → PR criado e completed", async () => {
    projectYaml("quality:\n  commands:\n    build: test -f a.txt\n    tests: test -f a.txt\n");
    const { feature, deps, input, prs } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    const graph = buildFeatureGraph(deps, new MemorySaver());
    const config = { configurable: { thread_id: feature.id } };
    await graph.invoke(input, config);

    const waiting = await repos.features.getById(feature.id);
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.deliverySummary).toContain("build: passed");
    expect(prs.created).toHaveLength(0);

    await graph.invoke(new Command({ resume: { action: "approve" } }), config);
    const done = await repos.features.getById(feature.id);
    expect(done?.status).toBe("completed");
    expect(done?.prUrl).toBe("https://example.test/pr/1");
    expect(prs.created[0]?.body).toContain("## Quality gates");
    const gates = (await repos.qualityResults.listByFeature(feature.id)).map(
      (row) => `${row.gate}:${row.status}`,
    );
    expect(gates).toEqual([
      "build:passed",
      "lint:skipped",
      "typecheck:skipped",
      "tests:passed",
      "requirements:passed",
      "review:passed",
    ]);
  });

  it("M4.5: reviewer com 2 findings → 2 Tasks corretivas → corrigidas → gates de novo → entrega", async () => {
    const { feature, deps, input, prs } = await setup({
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          (attemptInput) => {
            if (attemptInput.prompt.includes("Task: Review (high): falta validar")) {
              return { writeFile: { path: "validacao.txt", content: "ok" } };
            }
            if (attemptInput.prompt.includes("Task: Review (medium): falta teste")) {
              return { writeFile: { path: "teste.txt", content: "ok" } };
            }
            return { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" };
          },
          reviewerRounds(
            [
              { severity: "high", description: "falta validar a entrada", file: "a.txt" },
              { severity: "medium", description: "falta teste do caso vazio" },
              { severity: "low", description: "nome poderia ser melhor" },
            ],
            [],
          ),
        ),
      ],
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(done?.fixIteration).toBe(1);
    const corrective = tasks.filter((task) => task.origin === "review_fix");
    expect(corrective).toHaveLength(2); // o finding low não bloqueia
    expect(corrective.every((task) => task.status === "completed")).toBe(true);
    const iterations = (await repos.qualityResults.listByFeature(feature.id))
      .filter((row) => row.gate === "review")
      .map((row) => row.iteration);
    expect(iterations).toEqual([0, 1]);
    expect(prs.created[0]?.body).toContain("Rodadas de correção: 1");
  });

  it("Feature de documento: sem gates e sem Tasks corretivas; os achados vão para o humano", async () => {
    // O gate falharia se rodasse: provar que foi pulado.
    projectYaml("quality:\n  commands:\n    tests: exit 1\n");
    const { feature, deps, input } = await setup({
      intent: "document",
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          [{ writeFile: { path: "plano.md", content: "# plano" }, commit: "docs: plano" }],
          reviewerRounds([{ severity: "high", description: "falta a seção 5", file: "plano.md" }]),
        ),
      ],
    });
    const graph = buildFeatureGraph(deps, new MemorySaver());
    await graph.invoke(input, { configurable: { thread_id: feature.id } });

    const { feature: waiting, tasks } = await finalState(feature.id);
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.fixIteration).toBe(0);
    expect(tasks.filter((task) => task.origin === "review_fix")).toHaveLength(0);
    const rows = (await repos.qualityResults.listByFeature(feature.id)).map((row) => row.gate);
    expect(rows).toEqual(["requirements", "review"]); // nenhum gate de build/lint/tests
    expect(waiting?.deliverySummary).toContain("falta a seção 5");
    const events = (await repos.events.listByFeature(feature.id)).map((event) => event.type);
    expect(events).toContain("quality.skipped");
    // Passos do review visíveis: início e fim de cada chamada, com o resultado.
    const stepEvents = (await repos.events.listByFeature(feature.id)).filter((event) =>
      event.type.startsWith("review.step_"),
    );
    expect(
      stepEvents.map((event) => `${event.type}:${(event.payload as { step: string }).step}`),
    ).toEqual([
      "review.step_started:requirements",
      "review.step_finished:requirements",
      "review.step_started:review",
      "review.step_finished:review",
    ]);
    expect(stepEvents.at(-1)?.payload).toMatchObject({ ok: true, items: 1 });
    // O log da iteração ganha um marcador por passo, antes da saída do agente.
    const reviewLog = readFileSync(
      join(worktreesRoot, "logs", `${feature.id}-0.review.log`),
      "utf8",
    );
    expect(reviewLog).toContain("── requisitos · fake-a ──");
    expect(reviewLog).toContain("── review · fake-a ──");
  });

  it("M4.1/M4.5: gate falhando vira Task corretiva com a saída do comando", async () => {
    projectYaml(
      "quality:\n  commands:\n    tests: test -f ok.txt || (echo 'FALTA ok.txt' && exit 1)\n",
    );
    const harness = fakeTarget("fake-a", "anthropic", (attemptInput) =>
      attemptInput.prompt.includes("Task: Corrigir o gate tests")
        ? { writeFile: { path: "ok.txt", content: "ok" } }
        : { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
    );
    const { feature, deps, input } = await setup({ targets: [harness] });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const fix = tasks.find((task) => task.origin === "quality_fix");
    expect(fix?.description).toContain("FALTA ok.txt");
    const tests = (await repos.qualityResults.listByFeature(feature.id))
      .filter((row) => row.gate === "tests")
      .map((row) => row.status);
    expect(tests).toEqual(["failed", "passed"]);
  });

  it("M4.5: maxFixIterations estourado → needs_human, sem entregar", async () => {
    projectYaml("review:\n  maxFixIterations: 1\n");
    const always: Responder = (input) =>
      input.prompt.includes("Você é o Reviewer")
        ? {
            succeed: {
              structuredOutput: {
                findings: [{ severity: "critical", description: "sempre quebrado" }],
              },
            },
          }
        : approvingJudge(input);
    const { feature, deps, input, prs } = await setup({
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          (attemptInput) =>
            attemptInput.prompt.includes("Task: Review")
              ? { writeFile: { path: `fix-${randomUUID()}.txt`, content: "x" } }
              : { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
          always,
        ),
      ],
    });
    await run(deps, input);

    const { feature: done } = await finalState(feature.id);
    expect(done?.status).toBe("needs_human");
    expect(done?.fixIteration).toBe(1);
    expect(prs.created).toHaveLength(0);
  });

  it("M4.8: aprovação sobrevive a um 'restart' (graph novo sobre o mesmo checkpoint)", async () => {
    const { feature, deps, input, prs } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: feature.id } };
    await buildFeatureGraph(deps, checkpointer).invoke(input, config);
    expect((await repos.features.getById(feature.id))?.status).toBe("awaiting_approval");

    // Daemon novo: nada em memória além do checkpoint.
    await buildFeatureGraph(deps, checkpointer).invoke(
      new Command({ resume: { action: "approve" } }),
      config,
    );
    expect((await repos.features.getById(feature.id))?.status).toBe("completed");
    expect(prs.created).toHaveLength(1);
  });

  it("M4.9: falha ao abrir o PR (sem remote) → needs_human com o motivo, nada de status preso", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    deps.pullRequests = {
      create: async () => {
        throw new Error("FAKE-PR: fatal: 'origin' does not appear to be a git repository");
      },
    };
    await run(deps, input);

    const done = await repos.features.getById(feature.id);
    expect(done?.status).toBe("needs_human");
    expect(done?.prUrl).toBeNull();
    const events = await repos.events.listByFeature(feature.id);
    const reason = events.find((event) => event.type === "feature.needs_human")?.payload as {
      reason: string;
    };
    expect(reason.reason).toContain("origin");
  }, 30_000);

  it("M4.8: reject com motivo → Task de ajuste → nova revisão → aprovado", async () => {
    const { feature, deps, input, prs } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", (attemptInput) =>
          attemptInput.prompt.includes("Task: Ajustar conforme a revisão humana")
            ? { writeFile: { path: "titulo.txt", content: "novo" } }
            : { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ),
      ],
    });
    await run(deps, input, undefined, {
      approvals: [{ action: "reject", reason: "troque o título" }],
    });

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const fix = tasks.find((task) => task.origin === "human_fix");
    expect(fix?.description).toContain("troque o título");
    expect(prs.created).toHaveLength(1);
    const events = (await repos.events.listByFeature(feature.id)).map((event) => event.type);
    expect(events).toContain("feature.rejected");
    // O motivo do reject entra na verificação de requisitos da rodada seguinte.
    const harness = deps.targets[0]?.harness as FakeHarness;
    const checks = harness.receivedPrompts.filter((prompt) =>
      prompt.includes("Verifique se a mudança"),
    );
    expect(checks.at(-1)).toContain("(pedido na revisão humana) troque o título");
  });

  it("M4.6: planChangeRequest aceito pelo Lead vira Task nova (origin plan_change)", async () => {
    const lead: Responder = (input) =>
      input.prompt.includes("pediu uma mudança no plano")
        ? {
            succeed: {
              structuredOutput: {
                decision: "create_task",
                reason: "necessário para o objetivo",
                task: {
                  title: "migrar o banco",
                  description: "criar a migration",
                  kind: "write",
                  role: "generic",
                  expectedPaths: [],
                },
              },
            },
          }
        : approvingJudge(input);
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget(
          "fake-a",
          "anthropic",
          (attemptInput) =>
            attemptInput.prompt.includes("Task: migrar o banco")
              ? { writeFile: { path: "migration.sql", content: "--" }, commit: "feat: migration" }
              : {
                  writeFile: { path: "a.txt", content: "x" },
                  commit: "feat: a",
                  report: {
                    summary: "feito",
                    planChangeRequests: [
                      {
                        title: "migration",
                        description: "falta a migration",
                        reason: "a tabela não existe",
                      },
                    ],
                  },
                },
          lead,
        ),
      ],
    });
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks.find((task) => task.origin === "plan_change")?.status).toBe("completed");
    const messages = await repos.agentMessages.listByFeature(feature.id);
    expect(messages.map((message) => message.status)).toEqual(["accepted"]);
  });

  it("E2E seção 38 (FakeHarness): 3 Tasks paralelas, quota no meio, failover, reviewer com 2 problemas, correção, aprovação, PR", async () => {
    projectYaml(
      "quality:\n  commands:\n    build: test -f produtos.txt\n    lint: 'true'\n    typecheck: 'true'\n    tests: test -f api.txt\n",
    );
    let quotaHit = false;
    const work = (attemptInput: AgentExecutionInput): FakeHarnessStep => {
      if (attemptInput.prompt.includes("Task: API de produtos")) {
        return {
          delayMs: 200,
          writeFile: { path: "api.txt", content: "api" },
          commit: "feat: api",
        };
      }
      if (attemptInput.prompt.includes("Task: página de produtos")) {
        return {
          delayMs: 200,
          writeFile: { path: "produtos.txt", content: "ui" },
          commit: "feat: página",
        };
      }
      if (attemptInput.prompt.includes("Task: testes")) {
        return {
          delayMs: 200,
          writeFile: { path: "testes.txt", content: "t" },
          commit: "test: produtos",
        };
      }
      if (attemptInput.prompt.includes("Task: Review")) {
        return { writeFile: { path: `fix-${randomUUID().slice(0, 6)}.txt`, content: "fix" } };
      }
      return { succeed: {} };
    };
    const reviewer = reviewerRounds(
      [
        { severity: "high", description: "preço sem formatação", file: "produtos.txt" },
        { severity: "medium", description: "API sem paginação", file: "api.txt" },
      ],
      [],
    );
    const { feature, deps, input, capacity, prs } = await setup({
      targets: [
        fakeTarget(
          "fake-quota",
          "openai",
          (attemptInput) => {
            // O primeiro provider bate quota no meio da Task da página.
            if (attemptInput.prompt.includes("Task: página de produtos") && !quotaHit) {
              quotaHit = true;
              return {
                delayMs: 100,
                writeFile: { path: "produtos.txt", content: "meio" },
                commit: "wip",
                fail: { kind: "quota_exhausted" },
              };
            }
            // Como na vida real: depois que a quota acaba, chamada nova também
            // falha. (Antes o fake respondia sucesso, e uma Task que começasse
            // depois da falha — máquina lenta — "provava" que a quota voltou.)
            if (quotaHit) return { fail: { kind: "quota_exhausted" } };
            return work(attemptInput);
          },
          reviewer,
        ),
        fakeTarget("fake-backup", "anthropic", work, reviewer),
      ],
      featurePreference: { mode: "preferred", provider: "openai" },
      plan: planOf(
        { key: "t1", title: "API de produtos", role: "backend-developer" },
        { key: "t2", title: "página de produtos", role: "frontend-developer" },
        { key: "t3", title: "testes", role: "qa-engineer" },
      ),
    });
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(done?.prUrl).toBeTruthy();
    // Quota no meio → handover → outro provider.
    const pageTask = tasks.find((task) => task.title === "página de produtos");
    const pageAttempts = attempts.filter((attempt) => attempt.taskId === pageTask?.id);
    expect(pageAttempts.map((attempt) => [attempt.targetId, attempt.status])).toEqual([
      ["fake-quota", "failed"],
      ["fake-backup", "completed"],
    ]);
    expect(pageAttempts[1]?.handoverId).toBeTruthy();
    expect(capacity.get("openai").availability).toBe("exhausted");
    // Reviewer com 2 problemas → 2 corretivas → gates de novo.
    expect(tasks.filter((task) => task.origin === "review_fix")).toHaveLength(2);
    const rows = await repos.qualityResults.listByFeature(feature.id);
    expect(rows.filter((row) => row.gate === "build").map((row) => row.iteration)).toEqual([0, 1]);
    expect(rows.every((row) => row.status !== "failed")).toBe(true);
    expect(prs.created).toHaveLength(1);
  });

  // --- M5 ------------------------------------------------------------------

  it("M5.4: Jev fora do ar → a Feature conclui pelo RuleBasedRouter e a falha fica registrada", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    deps.taskRouter = {
      id: "jev",
      route: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    await run(deps, input);

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const decisions = await repos.routingDecisions.listByTask(tasks[0]?.id ?? "");
    expect(decisions[0]?.resolutionSource).toBe("rule_router");
    expect((decisions[0]?.output as { semanticError?: string }).semanticError).toContain(
      "ECONNREFUSED",
    );
    const events = (await repos.events.listByFeature(feature.id)).map((event) => event.type);
    expect(events).toContain("routing.semantic_failed");
  });

  it("M5.2/M5.5: o Jev escolhe o segundo target; a decisão e o motivo ficam no RoutingAudit", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [{ succeed: {} }]),
        fakeTarget("fake-b", "openai", [
          { writeFile: { path: "b.txt", content: "b" }, commit: "feat: b" },
        ]),
      ],
    });
    let calls = 0;
    deps.taskRouter = {
      id: "jev",
      route: async (routingInput) => {
        calls += 1;
        expect(routingInput.candidates.map((entry) => entry.candidate.targetId)).toEqual([
          "fake-a",
          "fake-b",
        ]);
        return {
          router: "jev:mock",
          complexity: "medium",
          risk: "low",
          requiresReview: 0.4,
          ranking: [
            { targetId: "fake-b", probability: 0.8 },
            { targetId: "fake-a", probability: 0.2 },
          ],
          confidence: 0.8,
        };
      },
    };
    await run(deps, input);

    const { feature: done, tasks, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(attempts.map((attempt) => attempt.targetId)).toEqual(["fake-b"]);
    expect(calls).toBe(1);
    const [decision] = await repos.routingDecisions.listByTask(tasks[0]?.id ?? "");
    expect(decision).toMatchObject({ router: "jev:mock", resolutionSource: "jev" });
    expect(decision?.output).toMatchObject({
      overriddenByPolicy: false,
      semantic: { complexity: "medium" },
    });
  });

  it("M5.9/M5.10: memória relevante entra no prompt do worker; ao concluir, o Lead destila e grava memórias", async () => {
    const harness = fakeTarget("fake-a", "anthropic", [
      { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
    ]);
    const { feature, deps, input } = await setup({ targets: [harness] });
    const queries: string[] = [];
    const remembered: Array<{ source: string; items: unknown[] }> = [];
    deps.memory = {
      retrieveForPrompt: async (_projectId, query) => {
        queries.push(query);
        return "## Contexto do projeto (memória)\n\n### Convenções [convention]\nValores monetários sempre em centavos.";
      },
      remember: async (_projectId, source, items) => {
        remembered.push({ source, items });
        return items.length;
      },
    };
    await run(deps, input);

    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const workerPrompt = (harness.harness as FakeHarness).receivedPrompts[0] ?? "";
    expect(workerPrompt).toContain("Valores monetários sempre em centavos.");
    expect(workerPrompt.indexOf("Valores monetários")).toBeGreaterThan(
      workerPrompt.indexOf("## Sua Task"),
    );
    expect(queries[0]).toContain(input.objective);
    expect(remembered).toEqual([
      {
        source: `feature:${feature.id}`,
        items: [
          { kind: "decision", title: "decisão de teste", content: "registrada pelo MemoryWriter" },
        ],
      },
    ]);
  });

  it("M5: memória falhando não derruba a Feature", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
      ],
    });
    deps.memory = {
      retrieveForPrompt: async () => {
        throw new Error("pgvector fora");
      },
      remember: async () => {
        throw new Error("pgvector fora");
      },
    };
    await run(deps, input);
    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const events = (await repos.events.listByFeature(feature.id)).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining(["memory.retrieve_failed", "memory.write_failed"]),
    );
  });

  // --- M6 ------------------------------------------------------------------

  it("M6.4: mudança de requisito com a Feature rodando → cancela o que não começou, replaneja e conclui", async () => {
    const replanJudge: Responder = (input) =>
      input.prompt.includes("Replaneje o restante")
        ? {
            // Lead mais lento que a Task em andamento: a regressão do E2E real
            // (gates e review rodando antes de o replan anexar as Tasks novas).
            delayMs: 900,
            succeed: {
              structuredOutput: {
                tasks: [
                  {
                    key: "t1",
                    title: "ui com filtro",
                    description: "UI com filtro por categoria",
                    kind: "write",
                    role: "generic",
                    expectedPaths: [],
                    dependsOn: [],
                  },
                ],
              },
            },
          }
        : approvingJudge(input);
    const harness = fakeTarget(
      "fake-a",
      "anthropic",
      byTitle({
        api: { delayMs: 600, writeFile: { path: "api.txt", content: "api" }, commit: "feat: api" },
        ui: { writeFile: { path: "ui.txt", content: "ui" }, commit: "feat: ui" },
        "ui com filtro": {
          writeFile: { path: "ui-filtro.txt", content: "ui+filtro" },
          commit: "feat: ui com filtro",
        },
      }),
      replanJudge,
    );
    const { feature, deps, input } = await setup({
      targets: [harness],
      plan: planOf({ key: "t1", title: "api" }, { key: "t2", title: "ui", dependsOn: ["t1"] }),
    });
    const running = run(deps, input);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const replan = await replanFeature(
      deps,
      new AgentRunnerImpl(harness.harness),
      {
        featureId: feature.id,
        projectId: feature.projectId,
        objective: input.objective,
        change: "a UI precisa ter filtro por categoria",
        reason: "mudança de requisito",
        roleIds: ["generic"],
        cwd: repoPath,
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    await running;

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(replan.cancelled).toHaveLength(1);
    expect(tasks.map((task) => [task.title, task.status])).toEqual([
      ["api", "completed"],
      ["ui", "cancelled"],
      ["ui com filtro", "completed"],
    ]);
    // A mudança entra na verificação de requisitos.
    const checks = (harness.harness as FakeHarness).receivedPrompts.filter((prompt) =>
      prompt.includes("Verifique se a mudança"),
    );
    expect(checks.at(-1)).toContain("(requisito alterado) a UI precisa ter filtro por categoria");
  });

  it("recursionLimit: Feature com 15 Tasks em cadeia não estoura o limite de passos do LangGraph", async () => {
    const steps: Record<string, FakeHarnessStep> = {};
    const tasks = Array.from({ length: 15 }, (_, index) => {
      const title = `passo-${index}`;
      steps[title] = {
        writeFile: { path: `${title}.txt`, content: title },
        commit: `feat: ${title}`,
      };
      return { key: `t${index}`, title, dependsOn: index === 0 ? [] : [`t${index - 1}`] };
    });
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", byTitle(steps))],
      plan: planOf(...tasks),
    });
    await run(deps, input);
    const { feature: done, tasks: rows } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(rows.every((task) => task.status === "completed")).toBe(true);
  }, 60_000);

  it("Feature nova parte da base atualizada do remoto (merge feito no GitHub depois do clone)", async () => {
    // origin "no GitHub" + o clone do APO (repoPath) já existente.
    const origin = join(worktreesRoot, "origin.git");
    await execa("git", ["clone", "--bare", "-q", repoPath, origin]);
    await execa("git", ["remote", "add", "origin", origin], { cwd: repoPath });
    await execa("git", ["fetch", "-q", "origin"], { cwd: repoPath });
    // Alguém mergeia um PR no remoto; o clone do APO fica para trás.
    const other = join(worktreesRoot, "outro-clone");
    await execa("git", ["clone", "-q", origin, other]);
    writeFileSync(join(other, "mergeado.txt"), "veio do PR anterior");
    await execa("git", ["add", "."], { cwd: other });
    await execa(
      "git",
      ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-qm", "merge do PR #1"],
      { cwd: other },
    );
    await execa("git", ["push", "-q", "origin", "main"], { cwd: other });

    const { feature, deps, input, integrationPath } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "novo.txt", content: "x" }, commit: "feat: novo" },
        ]),
      ],
    });
    await run(deps, input);

    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    expect(existsSync(join(integrationPath, "mergeado.txt"))).toBe(true);
    expect(existsSync(join(repoPath, "mergeado.txt"))).toBe(true);
    const events = (await repos.events.listByFeature(feature.id)).map((event) => event.type);
    expect(events).toContain("repo.synced");
  });

  // --- M7 ------------------------------------------------------------------

  const FILTER_QUESTION = {
    question: "O filtro aceita várias categorias ao mesmo tempo?",
    options: [
      { id: "a", label: "Uma por vez" },
      { id: "b", label: "Várias, com checkboxes" },
    ],
    recommended: "b",
    context: "API pronta; a UI depende da resposta.",
  };

  /** Worker de UI que pergunta na 1ª vez e conclui quando recebe a resposta. */
  function askingWorker() {
    return byTitle({
      api: { writeFile: { path: "api.txt", content: "api" }, commit: "feat: api" },
      "ui*": undefined as unknown as FakeHarnessStep,
    });
  }

  function questionTarget(judge: Responder = approvingJudge) {
    return fakeTarget(
      "fake-a",
      "anthropic",
      (attemptInput) => {
        if (attemptInput.prompt.includes("Resposta à sua pergunta")) {
          return {
            writeFile: { path: "ui.txt", content: "ui" },
            commit: "feat: ui",
            report: { summary: "ui feita" },
          };
        }
        if (attemptInput.prompt.includes("Task: ui")) {
          return { report: { summary: "parei para perguntar", question: FILTER_QUESTION } };
        }
        if (attemptInput.prompt.includes("Task: e2e")) {
          return { writeFile: { path: "e2e.txt", content: "e2e" }, commit: "test: e2e" };
        }
        return askingWorker()(attemptInput);
      },
      judge,
    );
  }

  const leadDecides =
    (confidence: number): Responder =>
    (input) =>
      input.prompt.includes("Um worker parou para perguntar")
        ? {
            succeed: {
              structuredOutput: {
                optionId: "b",
                answer: "b) Várias, com checkboxes",
                rationale: "segue a recomendação",
                confidence,
              },
            },
          }
        : approvingJudge(input);

  async function waitForStatus(taskTitle: string, featureId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const task = (await repos.tasks.listByFeature(featureId)).find(
        (candidate) => candidate.title === taskTitle,
      );
      if (task?.status === status) return task;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Task ${taskTitle} não chegou a ${status}`);
  }

  async function pendingQuestion(featureId: string) {
    const [question] = await repos.agentMessages.listPending(featureId, "question");
    if (!question) throw new Error("nenhuma pergunta pendente");
    return question;
  }

  it("M7: worker pergunta → Task espera, o resto segue → resposta humana retoma a MESMA sessão → Feature conclui", async () => {
    const target = questionTarget();
    const { feature, deps, input, prs } = await setup({
      targets: [target],
      plan: planOf(
        { key: "t1", title: "api" },
        { key: "t2", title: "ui" },
        { key: "t3", title: "e2e", dependsOn: ["t2"] },
      ),
    });
    const running = run(deps, input);
    const ui = await waitForStatus("ui", feature.id, "awaiting_answer");
    await waitForStatus("api", feature.id, "completed");
    expect(
      (await repos.tasks.listByFeature(feature.id)).find((task) => task.title === "e2e")?.status,
    ).toBe("ready");

    const question = await pendingQuestion(feature.id);
    const payload = question.payload as QuestionPayload;
    expect(payload).toMatchObject({
      question: FILTER_QUESTION.question,
      recommended: "b",
      taskId: ui.id,
    });
    const human = interpretHumanAnswer(payload, "b");
    await answerQuestion(deps, {
      questionId: question.id,
      projectId: feature.projectId,
      resolution: { ...human, answeredBy: "human", reason: "human" },
    });
    await running;

    const { feature: done, tasks } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
    const harness = target.harness as FakeHarness;
    expect(harness.resumedSessions).toEqual([payload.sessionId]);
    expect(
      harness.receivedPrompts.some((prompt) =>
        prompt.includes("Resposta (do usuário): b) Várias, com checkboxes"),
      ),
    ).toBe(true);
    expect(prs.created[0]?.body).toContain("## Decisões tomadas");
    expect(prs.created[0]?.body).toContain("(você)");
  }, 60_000);

  it("M7: modo auto na Feature → o Lead decide na hora, sem espera humana, e registra o motivo", async () => {
    const target = questionTarget(leadDecides(0.9));
    const { feature, deps, input, prs } = await setup({
      targets: [target],
      plan: planOf({ key: "t1", title: "ui" }),
    });
    await repos.features.update(feature.id, { questionMode: "auto" });
    await run(deps, input);

    const { feature: done } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    const [message] = await repos.agentMessages.listByFeature(feature.id);
    expect(message).toMatchObject({
      status: "auto",
      resolution: { answeredBy: "lead", reason: "auto", rationale: "segue a recomendação" },
    });
    expect(prs.created[0]?.body).toContain("Lead (você ausente)");
  }, 60_000);

  it("M7: modo global auto ligado DEPOIS da pergunta → a pendente é resolvida sem humano", async () => {
    const target = questionTarget(leadDecides(0.9));
    const { feature, deps, input } = await setup({
      targets: [target],
      plan: planOf({ key: "t1", title: "ui" }),
    });
    const running = run(deps, input);
    await waitForStatus("ui", feature.id, "awaiting_answer");
    await repos.settings.set("questions.mode", "auto");
    try {
      await running;
    } finally {
      await repos.settings.delete("questions.mode");
    }
    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const [message] = await repos.agentMessages.listByFeature(feature.id);
    expect(message?.status).toBe("auto");
  }, 60_000);

  it("M7: lead_first com confiança baixa → a pergunta vai para o humano; 'decida você' delega ao Lead", async () => {
    let calls = 0;
    const judge: Responder = (input) => {
      if (input.prompt.includes("Um worker parou para perguntar")) {
        calls += 1;
        const confidence = calls === 1 ? 0.3 : 0.6;
        return {
          succeed: {
            structuredOutput: {
              optionId: "a",
              answer: "a) Uma por vez",
              rationale: "mais simples",
              confidence,
            },
          },
        };
      }
      return approvingJudge(input);
    };
    const target = questionTarget(judge);
    const { feature, deps, input, prs } = await setup({
      targets: [target],
      plan: planOf({ key: "t1", title: "ui" }),
    });
    await repos.features.update(feature.id, { questionMode: "lead_first" });
    const running = run(deps, input);
    await waitForStatus("ui", feature.id, "awaiting_answer");
    const question = await pendingQuestion(feature.id);
    // "decida você": o Lead decide mesmo com confiança média.
    const lead = deps.targets[0]?.harness;
    if (!lead) throw new Error("sem harness");
    await resolveWithLead(
      deps,
      {
        questionId: question.id,
        projectId: feature.projectId,
        objective: input.objective,
        payload: question.payload as QuestionPayload,
        reason: "delegated",
        runner: new AgentRunnerImpl(lead),
        cwd: repoPath,
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    await running;
    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    expect(prs.created[0]?.body).toContain("Lead (delegado por você): mais simples");
  }, 60_000);

  it("M7: acima do teto de perguntas por Task, o Lead decide (reason limit)", async () => {
    projectYaml("questions:\n  maxPerTask: 0\n");
    const target = questionTarget(leadDecides(0.2));
    const { feature, deps, input } = await setup({
      targets: [target],
      plan: planOf({ key: "t1", title: "ui" }),
    });
    await run(deps, input);
    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    const [message] = await repos.agentMessages.listByFeature(feature.id);
    expect(message).toMatchObject({ status: "auto", resolution: { reason: "limit" } });
    expect((target.harness as FakeHarness).receivedPrompts[0]).toContain(
      "Não há como perguntar nesta Task",
    );
  }, 60_000);

  it("Review: o Reviewer bate limite de sessão → o review vai para o outro provider (antes: needs_human)", async () => {
    const quotaReviewer: Responder = (input) =>
      input.prompt.includes("Você é o Reviewer")
        ? { fail: { kind: "quota_exhausted" } }
        : approvingJudge(input);
    const { feature, deps, input, capacity } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" },
        ]),
        // Preferido para o review (provider diferente de quem implementou), mas sem quota.
        fakeTarget("fake-b", "openai", [], quotaReviewer),
      ],
      featurePreference: { mode: "forced", provider: "anthropic" },
    });
    await run(deps, input);

    expect((await finalState(feature.id)).feature?.status).toBe("completed");
    expect(capacity.get("openai").availability).toBe("exhausted");
    const review = (await repos.qualityResults.listByFeature(feature.id)).find(
      (row) => row.gate === "review",
    );
    expect((review?.details as { target: string }).target).toBe("fake-a");
  });
});
