import { eq } from "drizzle-orm";
import type { Db } from "./connection.js";
import {
  events,
  type featureStatusEnum,
  features,
  projects,
  taskAttempts,
  type taskStatusEnum,
  tasks,
} from "./schema.js";

type FeatureStatus = (typeof featureStatusEnum.enumValues)[number];
type TaskStatus = (typeof taskStatusEnum.enumValues)[number];

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
    return this.db.select().from(taskAttempts).where(eq(taskAttempts.taskId, taskId));
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
}
