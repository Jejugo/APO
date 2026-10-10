import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GlobalConfigSchema,
  apoHome,
  daemonPidFilePath,
  expandHome,
  globalConfigPath,
  isProcessAlive,
  loadConfig,
  readPidFile,
  removePidFileIfOwnedBy,
  writePidFile,
} from "@apo/config";
import {
  EventRepository,
  FeatureRepository,
  ProjectAgentRepository,
  ProjectRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import type { HarnessId } from "@apo/domain";
import { ClaudeCodeHarness, CodexHarness } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import type { HarnessRegistry } from "@apo/orchestrator";
import { FeatureRunner } from "./feature-runner.js";
import { buildServer } from "./server.js";

const DEFAULT_DATABASE_URL = "postgres://apo:apo@localhost:5433/apo";

async function main(): Promise<void> {
  const globalConfig = loadConfig(globalConfigPath(), GlobalConfigSchema);
  // `?? default`: mesma particularidade de inferência do zod com
  // exactOptionalPropertyTypes já registrada no M0 (packages/config/src/load.test.ts).
  const socketPath = expandHome(globalConfig.socketPath ?? "~/.apo/apo.sock");
  const pidFilePath = daemonPidFilePath(apoHome());
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const worktreesRoot = join(apoHome(), "worktrees");

  mkdirSync(apoHome(), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(dirname(socketPath), { recursive: true });

  const existingPid = readPidFile(pidFilePath);
  if (existingPid !== undefined && isProcessAlive(existingPid)) {
    console.error(`apo daemon já está rodando (pid ${existingPid})`);
    process.exit(1);
  }

  // Socket órfão de um daemon anterior que morreu sem limpar.
  rmSync(socketPath, { force: true });

  const logger = createLogger({});
  const db = createDb(databaseUrl);
  const projects = new ProjectRepository(db);
  const projectAgents = new ProjectAgentRepository(db);
  const features = new FeatureRepository(db);
  const tasks = new TaskRepository(db);
  const taskAttempts = new TaskAttemptRepository(db);
  const events = new EventRepository(db);

  const harnessRegistry: HarnessRegistry = {
    "claude-code": new ClaudeCodeHarness(),
    codex: new CodexHarness(),
  };

  const featureRunner = new FeatureRunner({
    logger,
    features,
    tasks,
    taskAttempts,
    events,
    databaseUrl,
    harnessRegistry,
  });
  await featureRunner.setup();

  // M1.13 — Recovery: nenhum attempt "working" sobrevive a um restart (o
  // processo que o executava morreu com o daemon); Features ainda ativas
  // retomam re-invocando o graph do zero — os nodes são idempotentes
  // (feature-graph.ts), então isso reusa a worktree e não duplica a Task.
  const interruptedCount = await taskAttempts.interruptAllWorking();
  if (interruptedCount > 0) {
    logger.info({ interruptedCount }, "recovery: attempts 'working' marcados como 'interrupted'");
  }

  const activeFeatures = await features.listByStatuses(["planning", "executing"]);
  for (const feature of activeFeatures) {
    const project = await projects.getById(feature.projectId);
    const executionPreference = feature.executionPreference as { harness?: HarnessId } | null;
    const harness = executionPreference?.harness;
    if (!project || !harness) {
      logger.warn(
        { featureId: feature.id },
        "recovery: feature ativa sem project ou harness — não foi retomada",
      );
      continue;
    }
    logger.info({ featureId: feature.id }, "recovery: retomando feature ativa");
    void featureRunner
      .run({
        featureId: feature.id,
        projectId: project.id,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        objective: feature.objective,
        harness,
        worktreesRoot,
      })
      .catch((error: unknown) => {
        logger.error({ error, featureId: feature.id }, "recovery: falha ao retomar feature");
      });
  }

  const app = buildServer({
    logger,
    projects,
    projectAgents,
    features,
    tasks,
    taskAttempts,
    events,
    featureRunner,
    harnessRegistry,
    worktreesRoot,
  });

  await app.listen({ path: socketPath });
  writePidFile(pidFilePath, process.pid);
  logger.info({ socketPath, pid: process.pid }, "apo daemon iniciado");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "apo daemon encerrando");
    await app.close();
    removePidFileIfOwnedBy(pidFilePath, process.pid);
    rmSync(socketPath, { force: true });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
