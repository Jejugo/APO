import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, createDb } from "./connection.js";
import {
  EventRepository,
  FeatureRepository,
  ProjectRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "./repositories.js";

// Integração real contra o Postgres do docker/compose.yaml (M0 "Testes
// obrigatórios": CRUD contra o Postgres do compose). Requer `pnpm db:up` e
// `pnpm db:migrate` antes de rodar.

describe("repositórios (integração com Postgres)", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb();
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("cria e lê Project, Feature, Task, TaskAttempt e Event via CRUD", async () => {
    const projectRepo = new ProjectRepository(db);
    const featureRepo = new FeatureRepository(db);
    const taskRepo = new TaskRepository(db);
    const attemptRepo = new TaskAttemptRepository(db);
    const eventRepo = new EventRepository(db);

    const project = await projectRepo.create({
      id: randomUUID(),
      name: "sample-repo",
      repoPath: "/tmp/sample-repo",
    });
    expect(project?.id).toBeDefined();
    if (!project) throw new Error("project não criado");

    const feature = await featureRepo.create({
      id: randomUUID(),
      projectId: project.id,
      objective: "criar página de produtos",
      intent: "feature",
    });
    expect(feature?.status).toBe("created");
    if (!feature) throw new Error("feature não criada");

    const task = await taskRepo.create({
      id: randomUUID(),
      featureId: feature.id,
      title: "criar ProductCard",
      description: "componente React reutilizável",
      kind: "write",
    });
    expect(task?.status).toBe("pending");
    if (!task) throw new Error("task não criada");

    const attempt = await attemptRepo.create({
      id: randomUUID(),
      taskId: task.id,
      n: 1,
      provider: "anthropic",
      harness: "claude-code",
    });
    expect(attempt?.status).toBe("starting");

    await eventRepo.insert({
      type: "task.created",
      featureId: feature.id,
      taskId: task.id,
      createdAt: new Date(),
    });

    const fetchedProject = await projectRepo.getById(project.id);
    expect(fetchedProject?.name).toBe("sample-repo");

    const tasksOfFeature = await taskRepo.listByFeature(feature.id);
    expect(tasksOfFeature).toHaveLength(1);

    const updated = await featureRepo.updateStatus(feature.id, "planning");
    expect(updated?.status).toBe("planning");
  });
});
