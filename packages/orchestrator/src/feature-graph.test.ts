// Integração do graph (SingleAgentEngine) com FakeHarness contra o Postgres do
// docker/compose.yaml — requer `pnpm db:up && pnpm db:migrate`.
// M1: Feature completed/failed/cancelled, verify, recovery idempotente.
// M3: failover entre providers, paused_capacity, forced indisponível, reroute.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { FakeHarness, type FakeHarnessStep } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import { CapacityMonitor } from "@apo/routing";
import { MemorySaver } from "@langchain/langgraph";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttemptControl } from "./attempt-control.js";
import { type FeatureGraphDeps, buildFeatureGraph } from "./feature-graph.js";
import type { ExecutionTargetEntry } from "./harness-registry.js";

function fakeTarget(
  targetId: string,
  provider: ProviderId,
  script: FakeHarnessStep[],
): ExecutionTargetEntry {
  return {
    candidate: { targetId, provider, harness: "fake" },
    harness: new FakeHarness({ label: targetId, provider, script }),
  };
}

describe("feature-graph — integração com FakeHarness", () => {
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
    repoPath = await mkdtemp(join(tmpdir(), "apo-feature-graph-repo-"));
    worktreesRoot = await mkdtemp(join(tmpdir(), "apo-feature-graph-worktrees-"));
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
  }) {
    const project = await repos.projects.create({
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
    });
    if (!feature) throw new Error("feature não criada");

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
    };
    const input = {
      featureId: feature.id,
      projectId: project.id,
      repoPath,
      defaultBranch: "main",
      objective,
      worktreesRoot,
    };
    return { feature, deps, input, capacity, worktreePath: join(worktreesRoot, feature.id) };
  }

  async function finalState(featureId: string) {
    const feature = await repos.features.getById(featureId);
    const [task] = await repos.tasks.listByFeature(featureId);
    const attempts = task ? await repos.taskAttempts.listByTask(task.id) : [];
    return { feature, task, attempts };
  }

  it("completa uma Feature de ponta a ponta com sucesso", async () => {
    const { feature, deps, input } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [
          { writeFile: { path: "novo.txt", content: "oi" }, commit: "feat: novo" },
        ]),
      ],
    });
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, task } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(task?.status).toBe("completed");
  });

  it("crash repetido no único target esgota os attempts e falha (sem pausar por capacidade)", async () => {
    const crash: FakeHarnessStep = { fail: { kind: "crash" } };
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [crash, crash, crash])],
    });
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("failed");
    expect(attempts).toHaveLength(3);
  });

  it("marca a Feature (e a Task) como cancelled quando o attempt é cancelado", async () => {
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [{ fail: { kind: "cancelled" } }])],
    });
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, task } = await finalState(feature.id);
    expect(done?.status).toBe("cancelled");
    expect(task?.status).toBe("cancelled");
  });

  // Regressão do M1: o cancelamento viaja por `configurable`, não pelo `signal`
  // de nível top do invoke() — senão o graph inteiro aborta e a Feature fica
  // presa em "executing".
  it("cancelamento externo interrompe o harness e o graph ainda grava 'cancelled'", async () => {
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [{ delayMs: 5_000, succeed: {} }])],
    });
    const control = new AttemptControl();
    setTimeout(() => control.cancel(), 50);
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id, attemptControl: control },
    });

    expect((await finalState(feature.id)).feature?.status).toBe("cancelled");
  });

  it("marca a Feature como failed quando o harness sucede mas não gera commit (verify)", async () => {
    const { feature, deps, input } = await setup({
      targets: [fakeTarget("fake-a", "anthropic", [{ succeed: {} }])],
    });
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    expect((await finalState(feature.id)).feature?.status).toBe("failed");
  });

  it("recovery (M1.13): re-invocar o graph do zero não duplica a Task nem re-executa o worker", async () => {
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

    const tasks = await repos.tasks.listByFeature(feature.id);
    expect(tasks).toHaveLength(1);
    expect((await finalState(feature.id)).attempts).toHaveLength(1);
  });

  // M3 — critério central da V1.
  it("failover: rate limit no meio → handover → outro provider conclui, preservando o trabalho", async () => {
    const { feature, deps, input, capacity, worktreePath } = await setup({
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
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, task, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(attempts.map((attempt) => [attempt.targetId, attempt.status])).toEqual([
      ["fake-a", "rate_limited"],
      ["fake-b", "completed"],
    ]);
    expect(attempts[1]?.handoverId).toBeTruthy();
    // O trabalho de A continua na branch depois da troca.
    expect(existsSync(join(worktreePath, "parte-a.txt"))).toBe(true);
    expect(existsSync(join(worktreePath, "parte-b.txt"))).toBe(true);
    expect(capacity.get("anthropic").availability).toBe("degraded");

    const handover = await repos.handovers.getById(attempts[1]?.handoverId ?? "");
    expect((handover?.payload as { changedFiles: string[] }).changedFiles).toContain("parte-a.txt");
    if (!task) throw new Error("task ausente");
    expect(await repos.routingDecisions.listByTask(task.id)).toHaveLength(2);
  });

  it("todos os providers esgotados → paused_capacity, sem rodar nenhum worker", async () => {
    const capacity = new CapacityMonitor();
    capacity.recordFailure("anthropic", { kind: "quota_exhausted", message: "limite" });
    capacity.recordFailure("openai", { kind: "quota_exhausted", message: "limite" });
    const { feature, deps, input } = await setup({
      capacity,
      targets: [fakeTarget("fake-a", "anthropic", []), fakeTarget("fake-b", "openai", [])],
    });
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, task, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("paused_capacity");
    expect(task?.status).toBe("retrying");
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
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id },
    });

    const { feature: done, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("needs_human");
    expect(attempts).toHaveLength(0);
  });

  it("reroute manual (M3.10): interrompe o attempt atual e conclui no target pedido", async () => {
    const { feature, deps, input, worktreePath } = await setup({
      targets: [
        fakeTarget("fake-a", "anthropic", [{ delayMs: 5_000, succeed: {} }]),
        fakeTarget("fake-b", "openai", [
          { writeFile: { path: "b.txt", content: "b" }, commit: "feat: b" },
        ]),
      ],
    });
    const control = new AttemptControl();
    setTimeout(() => control.reroute({ mode: "forced", provider: "openai" }), 100);
    await buildFeatureGraph(deps, new MemorySaver()).invoke(input, {
      configurable: { thread_id: feature.id, attemptControl: control },
    });

    const { feature: done, task, attempts } = await finalState(feature.id);
    expect(done?.status).toBe("completed");
    expect(attempts.map((attempt) => attempt.targetId)).toEqual(["fake-a", "fake-b"]);
    expect(task?.executionPreference).toEqual({ mode: "forced", provider: "openai" });
    expect(existsSync(join(worktreePath, "b.txt"))).toBe(true);
  });
});
