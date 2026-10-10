// M1 — "Testes obrigatórios": E2E com FakeHarness (Feature completed, commit
// na branch). Integração real contra o Postgres do docker/compose.yaml
// (mesmo requisito de `pnpm db:up && pnpm db:migrate` do packages/db).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  EventRepository,
  FeatureRepository,
  ProjectRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import { FakeHarness } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import { MemorySaver } from "@langchain/langgraph";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FeatureGraphDeps, buildFeatureGraph } from "./feature-graph.js";

describe("feature-graph (M1.9) — integração com FakeHarness", () => {
  let db: Db;
  let repoPath: string;
  let worktreesRoot: string;
  let deps: Omit<FeatureGraphDeps, "harnessRegistry">;
  let projects: ProjectRepository;

  beforeAll(() => {
    db = createDb();
    const features = new FeatureRepository(db);
    const tasks = new TaskRepository(db);
    const taskAttempts = new TaskAttemptRepository(db);
    const events = new EventRepository(db);
    deps = { logger: createLogger({}), features, tasks, taskAttempts, events };
    projects = new ProjectRepository(db);
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

  it("completa uma Feature de ponta a ponta com sucesso", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "adicione um arquivo novo",
      intent: "feature",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({
      script: [{ writeFile: { path: "novo.txt", content: "oi" }, commit: "feat: novo arquivo" }],
    });
    const graph = buildFeatureGraph(
      { ...deps, harnessRegistry: { fake: harness } },
      new MemorySaver(),
    );

    await graph.invoke(
      {
        featureId: feature.id,
        projectId: project.id,
        repoPath,
        defaultBranch: "main",
        objective: "adicione um arquivo novo",
        harness: "fake",
        worktreesRoot,
      },
      { configurable: { thread_id: feature.id } },
    );

    const finalFeature = await deps.features.getById(feature.id);
    expect(finalFeature?.status).toBe("completed");

    const taskList = await deps.tasks.listByFeature(feature.id);
    expect(taskList).toHaveLength(1);
    expect(taskList[0]?.status).toBe("completed");
  });

  it("marca a Feature como failed quando o harness falha", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "objetivo que falha",
      intent: "bugfix",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({ script: [{ fail: { kind: "crash" } }] });
    const graph = buildFeatureGraph(
      { ...deps, harnessRegistry: { fake: harness } },
      new MemorySaver(),
    );

    await graph.invoke(
      {
        featureId: feature.id,
        projectId: project.id,
        repoPath,
        defaultBranch: "main",
        objective: "objetivo que falha",
        harness: "fake",
        worktreesRoot,
      },
      { configurable: { thread_id: feature.id } },
    );

    const finalFeature = await deps.features.getById(feature.id);
    expect(finalFeature?.status).toBe("failed");
  });

  it("marca a Feature (e a Task) como cancelled quando o attempt é cancelado, nunca como failed", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "objetivo cancelado",
      intent: "bugfix",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({ script: [{ fail: { kind: "cancelled" } }] });
    const graph = buildFeatureGraph(
      { ...deps, harnessRegistry: { fake: harness } },
      new MemorySaver(),
    );

    await graph.invoke(
      {
        featureId: feature.id,
        projectId: project.id,
        repoPath,
        defaultBranch: "main",
        objective: "objetivo cancelado",
        harness: "fake",
        worktreesRoot,
      },
      { configurable: { thread_id: feature.id } },
    );

    const finalFeature = await deps.features.getById(feature.id);
    expect(finalFeature?.status).toBe("cancelled");

    const taskList = await deps.tasks.listByFeature(feature.id);
    expect(taskList[0]?.status).toBe("cancelled");
  });

  // Regressão: o cancelSignal passado via `configurable` (não via `signal`
  // de nível top do invoke()) precisa interromper só a chamada do harness,
  // deixando 'verify'/'complete' rodarem e escreverem o status terminal.
  // Usar o `signal` de nível top fazia o LangGraph abortar a invocação
  // inteira — a Feature ficava presa em "executing" pra sempre, sem nenhum
  // node depois de 'execute' nunca rodar (só descoberto em execução real).
  it("um cancelSignal externo interrompe o harness mas deixa o graph terminar e gravar 'cancelled'", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "objetivo cancelado de fora",
      intent: "bugfix",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({ script: [{ delayMs: 5_000, succeed: {} }] });
    const graph = buildFeatureGraph(
      { ...deps, harnessRegistry: { fake: harness } },
      new MemorySaver(),
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await graph.invoke(
      {
        featureId: feature.id,
        projectId: project.id,
        repoPath,
        defaultBranch: "main",
        objective: "objetivo cancelado de fora",
        harness: "fake",
        worktreesRoot,
      },
      { configurable: { thread_id: feature.id, cancelSignal: controller.signal } },
    );

    const finalFeature = await deps.features.getById(feature.id);
    expect(finalFeature?.status).toBe("cancelled");
  });

  it("marca a Feature como failed quando o harness sucede mas não gera commit (falha no verify)", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "objetivo sem commit",
      intent: "bugfix",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({ script: [{ succeed: {} }] });
    const graph = buildFeatureGraph(
      { ...deps, harnessRegistry: { fake: harness } },
      new MemorySaver(),
    );

    await graph.invoke(
      {
        featureId: feature.id,
        projectId: project.id,
        repoPath,
        defaultBranch: "main",
        objective: "objetivo sem commit",
        harness: "fake",
        worktreesRoot,
      },
      { configurable: { thread_id: feature.id } },
    );

    const finalFeature = await deps.features.getById(feature.id);
    expect(finalFeature?.status).toBe("failed");
  });

  it("recovery (M1.13): re-invocar o graph do zero não duplica a Task nem re-executa o worker", async () => {
    const project = await projects.create({
      id: randomUUID(),
      name: "teste",
      repoPath,
      defaultBranch: "main",
    });
    if (!project) throw new Error("project não criado");
    const feature = await deps.features.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "idempotência",
      intent: "feature",
    });
    if (!feature) throw new Error("feature não criada");

    const harness = new FakeHarness({
      script: [{ writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" }],
    });
    const graphDeps = { ...deps, harnessRegistry: { fake: harness } };
    const checkpointer = new MemorySaver();
    const input = {
      featureId: feature.id,
      projectId: project.id,
      repoPath,
      defaultBranch: "main",
      objective: "idempotência",
      harness: "fake" as const,
      worktreesRoot,
    };
    const config = { configurable: { thread_id: feature.id } };

    await buildFeatureGraph(graphDeps, checkpointer).invoke(input, config);
    // Simula um daemon reiniciado: graph reconstruído, mesmo checkpointer, mesmo input completo.
    await buildFeatureGraph(graphDeps, checkpointer).invoke(input, config);

    const taskList = await deps.tasks.listByFeature(feature.id);
    expect(taskList).toHaveLength(1);
    const task = taskList[0];
    if (!task) throw new Error("task não encontrada");
    const attempts = await deps.taskAttempts.listByTask(task.id);
    expect(attempts).toHaveLength(1);
  });
});
