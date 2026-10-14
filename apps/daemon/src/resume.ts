// Retomada de Features: recovery no boot (M1.13) e saída de
// `paused_capacity` quando algum provider volta (M3.9). Os dois usam o mesmo
// mecanismo — re-invocar o graph, cujos nodes são idempotentes.

import { existsSync } from "node:fs";
import type { FeatureRepository, ProjectRepository } from "@apo/db";
import type { Logger } from "@apo/observability";
import type { TargetRegistry } from "@apo/orchestrator";
import type { CapacityMonitor } from "@apo/routing";
import type { FeatureRunner } from "./feature-runner.js";

interface ResumeDeps {
  features: FeatureRepository;
  projects: ProjectRepository;
  featureRunner: FeatureRunner;
  logger: Logger;
  worktreesRoot: string;
  /** Usado para ler o `resumeAt` da última pausa por capacidade. */
  events?: EventLog;
}

interface EventLog {
  listByFeature(featureId: string): Promise<Array<{ type: string; payload: unknown }>>;
}

/** `resumeAt` da última pausa por capacidade da Feature, se houver. */
export async function pausedUntil(events: EventLog, featureId: string): Promise<Date | undefined> {
  const paused = (await events.listByFeature(featureId)).filter(
    (event) => event.type === "feature.paused_capacity",
  );
  const resumeAt = (paused.at(-1)?.payload as { resumeAt?: unknown } | undefined)?.resumeAt;
  return typeof resumeAt === "string" ? new Date(resumeAt) : undefined;
}

export async function resumeFeatures(
  deps: ResumeDeps,
  statuses: Parameters<FeatureRepository["listByStatuses"]>[0],
  reason: string,
  eligible?: (featureId: string) => Promise<boolean>,
): Promise<number> {
  let resumed = 0;
  for (const feature of await deps.features.listByStatuses(statuses)) {
    if (deps.featureRunner.isRunning(feature.id)) continue;
    if (eligible && !(await eligible(feature.id))) continue;
    const project = await deps.projects.getById(feature.projectId);
    // Repos temporários de testes antigos não existem mais — retomar só
    // geraria erro a cada boot.
    if (!project || !existsSync(project.repoPath)) {
      deps.logger.warn(
        { featureId: feature.id },
        `${reason}: repo do project não existe mais — não retomada`,
      );
      continue;
    }
    deps.logger.info({ featureId: feature.id }, `${reason}: retomando feature`);
    resumed += 1;
    void deps.featureRunner
      .run({
        featureId: feature.id,
        projectId: project.id,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        objective: feature.objective,
        worktreesRoot: deps.worktreesRoot,
      })
      .catch((error: unknown) => {
        deps.logger.error({ error, featureId: feature.id }, `${reason}: falha ao retomar feature`);
      });
  }
  return resumed;
}

/** M3.9: verifica periodicamente se algum provider voltou e retoma as Features pausadas. */
export function startCapacityResumer(
  deps: ResumeDeps & { capacity: CapacityMonitor; targets: TargetRegistry },
  intervalMs = 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const anyUsable = deps.targets.some((entry) => {
      const availability = deps.capacity.get(entry.candidate.provider).availability;
      return availability === "available" || availability === "unknown";
    });
    if (!anyUsable) return;
    // Só acorda a Feature depois do `resumeAt` da pausa: antes disso, a
    // capacidade "voltar" (provider `unknown`) não quer dizer que ela pode rodar.
    const eligible = async (featureId: string) => {
      if (!deps.events) return true;
      const until = await pausedUntil(deps.events, featureId);
      return !until || Date.now() >= until.getTime();
    };
    void resumeFeatures(deps, ["paused_capacity"], "capacity-resume", eligible).catch(
      (error: unknown) => {
        deps.logger.error({ error }, "capacity-resume falhou");
      },
    );
  }, intervalMs);
  timer.unref();
  return timer;
}
