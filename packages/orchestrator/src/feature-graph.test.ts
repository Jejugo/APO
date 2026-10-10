// Integração do ApoNativeEngine com FakeHarness contra o Postgres do
// docker/compose.yaml — requer `pnpm db:up && pnpm db:migrate`.
// M1: completed/failed/cancelled, verify, recovery idempotente.
// M2: DAG em ondas paralelas, dependente enxerga o código das dependências,
//     artefatos, conflito → Task corretiva, role no prompt, Task read em shared,
//     duas Features ao mesmo tempo.
// M3: failover entre providers, paused_capacity, forced indisponível, reroute.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Db,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectRepository,
  RoutingDecisionRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import type { ExecutionPreference, ProviderId } from "@apo/domain";
import { type AgentExecutionInput, FakeHarness, type FakeHarnessStep } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import { CapacityMonitor } from "@apo/routing";
import { MemorySaver } from "@langchain/langgraph";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttemptControl } from "./attempt-control.js";
import { type FeatureGraphDeps, buildFeatureGraph } from "./feature-graph.js";
import type { ExecutionTargetEntry } from "./harness-registry.js";
import type { FeaturePlan } from "./plan.js";
import { WORKER_CONTRACT } from "./prompt-builder.js";
import { WorkerSlots } from "./worker-slots.js";

function fakeTarget(
  targetId: string,
  provider: ProviderId,
  script: FakeHarnessStep[] | ((input: AgentExecutionInput) => FakeHarnessStep | undefined),
): ExecutionTargetEntry {
  return {
    candidate: { targetId, provider, harness: "fake" },
    harness: new FakeHarness(
      Array.isArray(script)
        ? { label: targetId, provider, script }
        : { label: targetId, provider, respond: script },
    ),
  };
}

/** Escolhe o passo pela Task (o prompt traz "Task: <título>"). */
function byTitle(steps: Record<string, FakeHarnessStep>) {
  return (input: AgentExecutionInput) => {
    const title = Object.keys(steps).find((key) => input.prompt.includes(`Task: ${key}`));
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
    };
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
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
      intent: "feature",
      ...(options.featurePreference ? { executionPreference: options.featurePreference } : {}),
      ...(options.plan ? { plan: options.plan } : {}),
    });
    if (!feature) throw new Error("feature não criada");
    project = undefined as never;

    const capacity = options.capacity ?? new CapacityMonitor();
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
      attemptLogPath: (attemptId) => join(worktreesRoot, "logs", `${attemptId}.log`),
      runsRoot: join(worktreesRoot, "runs"),
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
    return { feature, deps, input, capacity, integrationPath };
  }

  async function run(
    deps: FeatureGraphDeps,
    input: Awaited<ReturnType<typeof setup>>["input"],
    control?: AttemptControl,
  ) {
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: input.featureId, ...(control ? { attemptControl: control } : {}) },
    });
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
            "Resolver conflito": { writeFile: { path: "config.txt", content: "valor=A+B\n" } },
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
});
