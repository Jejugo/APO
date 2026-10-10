// Anexar Tasks a uma Feature já existente (M2.11). Primitivo comum a três
// caminhos: o plano inicial (node `plan`), a Task corretiva de conflito (M2.8)
// e a absorção de um pedido sobreposto (M2.13). O graph relê as Tasks do banco
// a cada onda, então Tasks anexadas com a Feature em execução entram na
// próxima onda sem recriar nada.

import { randomUUID } from "node:crypto";
import type { TaskRepository } from "@apo/db";
import type { FeaturePlan } from "./plan.js";

export async function appendTasks(
  tasks: Pick<TaskRepository, "listByFeature" | "create">,
  featureId: string,
  plan: FeaturePlan,
  origin: string,
  extra: { branch?: string } = {},
): Promise<string[]> {
  const existing = await tasks.listByFeature(featureId);
  let seq = existing.reduce((max, task) => Math.max(max, task.seq), 0);
  const ids = new Map(plan.tasks.map((task) => [task.key, randomUUID()]));
  for (const planned of plan.tasks) {
    seq += 1;
    await tasks.create({
      id: ids.get(planned.key) as string,
      featureId,
      seq,
      title: planned.title,
      description: planned.description,
      kind: planned.kind,
      role: planned.role,
      expectedPaths: planned.expectedPaths,
      dependencies: planned.dependsOn.map((key) => ids.get(key) as string),
      status: "ready",
      origin,
      ...(extra.branch ? { branch: extra.branch } : {}),
    });
  }
  return [...ids.values()];
}
