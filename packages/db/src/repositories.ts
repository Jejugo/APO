import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "./connection.js";
import {
  events,
  type featureStatusEnum,
  features,
  handovers,
  projectAgents,
  projects,
  providerCapacity,
  routingDecisions,
  type taskAttemptStatusEnum,
  taskAttempts,
  type taskStatusEnum,
  tasks,
} from "./schema.js";

type FeatureStatus = (typeof featureStatusEnum.enumValues)[number];
type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
type TaskAttemptStatus = (typeof taskAttemptStatusEnum.enumValues)[number];

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  create(input: typeof projects.$inferInsert) {
    return this.db
      .insert(projects)
      .values(input)
      .returning()
      .then(([row]) => row);
  }

  getById(id: string) {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .then(([row]) => row);
  }

  list() {
    return this.db.select().from(projects);
  }
}

export class FeatureRepository {
  constructor(private readonly db: Db) {}

  create(input: typeof features.$inferInsert) {
    return this.db
      .insert(features)
      .values(input)
      .returning()
      .then(([row]) => row);
  }

  getById(id: string) {
    return this.db
      .select()
      .from(features)
      .where(eq(features.id, id))
      .then(([row]) => row);
  }

  listByProject(projectId: string) {
    return this.db.select().from(features).where(eq(features.projectId, projectId));
  }

  updateExecutionPreference(id: string, executionPreference: unknown) {
    return this.db
      .update(features)
      .set({ executionPreference, updatedAt: new Date() })
      .where(eq(features.id, id))
      .returning()
      .then(([row]) => row);
  }

  /** Global, não restrito a um Project — usado na recovery do daemon (M1.13). */
  listByStatuses(statuses: FeatureStatus[]) {
    return this.db.select().from(features).where(inArray(features.status, statuses));
  }

  updateStatus(id: string, status: FeatureStatus) {
    return this.db
      .update(features)
      .set({ status, updatedAt: new Date() })
      .where(eq(features.id, id))
      .returning()
      .then(([row]) => row);
  }
}

export class TaskRepository {
  constructor(private readonly db: Db) {}

  create(input: typeof tasks.$inferInsert) {
    return this.db
      .insert(tasks)
      .values(input)
      .returning()
      .then(([row]) => row);
  }

  getById(id: string) {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .then(([row]) => row);
  }

  listByFeature(featureId: string) {
    return this.db.select().from(tasks).where(eq(tasks.featureId, featureId));
  }

  update(
    id: string,
    changes: Partial<{
      status: TaskStatus;
      worktreePath: string;
      branch: string;
      executionPreference: unknown;
    }>,
  ) {
    return this.db
      .update(tasks)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning()
      .then(([row]) => row);
  }

  updateStatus(id: string, status: TaskStatus) {
    return this.db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning()
      .then(([row]) => row);
  }
}

export class TaskAttemptRepository {
  constructor(private readonly db: Db) {}

  create(input: typeof taskAttempts.$inferInsert) {
    return this.db
      .insert(taskAttempts)
      .values(input)
      .returning()
      .then(([row]) => row);
  }

  getById(id: string) {
    return this.db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.id, id))
      .then(([row]) => row);
  }

  listByTask(taskId: string) {
    return this.db
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, taskId))
      .orderBy(asc(taskAttempts.n));
  }

  update(
    id: string,
    changes: Partial<{
      status: TaskAttemptStatus;
      failureKind: string | null;
      failureMessage: string | null;
      pid: number | null;
      endedAt: Date;
    }>,
  ) {
    return this.db
      .update(taskAttempts)
      .set(changes)
      .where(eq(taskAttempts.id, id))
      .returning()
      .then(([row]) => row);
  }

  /** Recovery do daemon (M1.13): nenhum attempt "working" sobrevive a um restart — o processo que o executava morreu com o daemon. */
  async interruptAllWorking(): Promise<number> {
    const rows = await this.db
      .update(taskAttempts)
      .set({ status: "interrupted", endedAt: new Date() })
      .where(eq(taskAttempts.status, "working"))
      .returning({ id: taskAttempts.id });
    return rows.length;
  }
}

export class ProjectAgentRepository {
  constructor(private readonly db: Db) {}

  create(input: typeof projectAgents.$inferInsert) {
    return this.db
      .insert(projectAgents)
      .values(input)
      .returning()
      .then(([row]) => row);
  }

  getByProjectAndRole(projectId: string, roleId: string) {
    return this.db
      .select()
      .from(projectAgents)
      .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.roleId, roleId)))
      .then(([row]) => row);
  }

  listByProject(projectId: string) {
    return this.db.select().from(projectAgents).where(eq(projectAgents.projectId, projectId));
  }
}

type ProviderCapacityRow = typeof providerCapacity.$inferSelect;

export class ProviderCapacityRepository {
  constructor(private readonly db: Db) {}

  upsert(row: typeof providerCapacity.$inferInsert) {
    const { provider: _provider, ...rest } = row;
    return this.db
      .insert(providerCapacity)
      .values(row)
      .onConflictDoUpdate({ target: providerCapacity.provider, set: rest })
      .returning()
      .then(([saved]) => saved);
  }

  list(): Promise<ProviderCapacityRow[]> {
    return this.db.select().from(providerCapacity);
  }
}

export class RoutingDecisionRepository {
  constructor(private readonly db: Db) {}

  insert(row: typeof routingDecisions.$inferInsert) {
    return this.db
      .insert(routingDecisions)
      .values(row)
      .returning()
      .then(([saved]) => saved);
  }

  listByTask(taskId: string) {
    return this.db
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.taskId, taskId))
      .orderBy(asc(routingDecisions.createdAt));
  }
}

export class HandoverRepository {
  constructor(private readonly db: Db) {}

  create(row: typeof handovers.$inferInsert) {
    return this.db
      .insert(handovers)
      .values(row)
      .returning()
      .then(([saved]) => saved);
  }

  getById(id: string) {
    return this.db
      .select()
      .from(handovers)
      .where(eq(handovers.id, id))
      .then(([row]) => row);
  }

  listByTask(taskId: string) {
    return this.db
      .select()
      .from(handovers)
      .where(eq(handovers.taskId, taskId))
      .orderBy(asc(handovers.createdAt));
  }
}

/** Implementa a forma de `EventSink` de @apo/observability, sem depender do pacote. */
export class EventRepository {
  constructor(private readonly db: Db) {}

  async insert(event: {
    type: string;
    projectId?: string;
    featureId?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
    createdAt: Date;
  }): Promise<void> {
    await this.db.insert(events).values({
      type: event.type,
      projectId: event.projectId ?? null,
      featureId: event.featureId ?? null,
      taskId: event.taskId ?? null,
      payload: event.payload ?? null,
      createdAt: event.createdAt,
    });
  }

  /** `afterId` para polling incremental (M1.12 — `apo logs -f`). */
  listByFeature(featureId: string, afterId?: number) {
    return this.db
      .select()
      .from(events)
      .where(
        afterId !== undefined
          ? and(eq(events.featureId, featureId), gt(events.id, afterId))
          : eq(events.featureId, featureId),
      )
      .orderBy(events.id);
  }
}
