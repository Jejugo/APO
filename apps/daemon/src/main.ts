import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
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
  AgentMessageRepository,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectAgentRepository,
  ProjectRepository,
  ProviderCapacityRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import { buildWorkerEnvironment } from "@apo/harnesses";
import { createLogger } from "@apo/observability";
import { WorkerSlots } from "@apo/orchestrator";
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from "@apo/routing";
import { createCapacityMonitor } from "./capacity.js";
import { FeatureRunner } from "./feature-runner.js";
import { resumeFeatures, startCapacityResumer } from "./resume.js";
import { buildServer } from "./server.js";
import { buildTargetRegistry } from "./targets.js";

const DEFAULT_DATABASE_URL = "postgres://apo:apo@localhost:5433/apo";

async function main(): Promise<void> {
  const globalConfig = loadConfig(globalConfigPath(), GlobalConfigSchema);
  // `?? default`: mesma particularidade de inferência do zod com
  // exactOptionalPropertyTypes já registrada no M0 (packages/config/src/load.test.ts).
  const socketPath = expandHome(globalConfig.socketPath ?? "~/.apo/apo.sock");
  const providersConfig = GlobalConfigSchema.shape.providers.parse(globalConfig.providers ?? {});
  const limits = globalConfig.limits;
  const routing = globalConfig.routing;
  const routingPolicy: RoutingPolicy = {
    capacityAware: routing?.capacityAware ?? DEFAULT_ROUTING_POLICY.capacityAware,
    degradedAt: routing?.degradedAt ?? DEFAULT_ROUTING_POLICY.degradedAt,
    avoidAt: routing?.avoidAt ?? DEFAULT_ROUTING_POLICY.avoidAt,
    preferLowerUsageDifference:
      routing?.preferLowerUsageDifference ?? DEFAULT_ROUTING_POLICY.preferLowerUsageDifference,
  };
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
  const routingDecisions = new RoutingDecisionRepository(db);
  const handovers = new HandoverRepository(db);
  const providerCapacity = new ProviderCapacityRepository(db);
  const qualityResults = new QualityResultRepository(db);
  const agentMessages = new AgentMessageRepository(db);

  const targets = buildTargetRegistry(providersConfig.targets, logger);
  if (targets.length === 0) {
    console.error("nenhum target de execução habilitado em providers.targets do config.yaml");
    process.exit(1);
  }

  const capacity = await createCapacityMonitor({
    repository: providerCapacity,
    events,
    logger,
    unknownResetRetryMs: providersConfig.unknownResetRetryMinutes * 60_000,
  });

  const featureRunner = new FeatureRunner(
    {
      logger,
      features,
      tasks,
      taskAttempts,
      events,
      routingDecisions,
      handovers,
      targets,
      capacity,
      maxAttemptsPerTask: providersConfig.maxAttemptsPerTask,
      qualityResults,
      agentMessages,
      routingPolicy,
      // M3.0b: allowlist base + o que o Project autorizar em .apo/project.yaml.
      workerEnv: (repoPath) => {
        const projectConfig = loadConfig(
          join(repoPath, ".apo", "project.yaml"),
          ProjectConfigSchema,
        );
        return buildWorkerEnvironment(projectConfig.worker?.env?.allow ?? []);
      },
      attemptLogPath: (attemptId) => join(apoHome(), "logs", "attempts", `${attemptId}.log`),
      runsRoot: join(apoHome(), "runs"),
      stallTimeoutMs: (limits?.stallTimeoutMinutes ?? 10) * 60_000,
      // M2.4: compartilhado entre todas as Features do daemon.
      slots: new WorkerSlots(limits?.maxGlobalWorkers ?? 4, limits?.maxWorkersPerProvider ?? 2),
    },
    databaseUrl,
  );
  await featureRunner.setup();

  // M1.13 — Recovery: nenhum attempt "working" sobrevive a um restart; Features
  // ativas retomam re-invocando o graph (nodes idempotentes).
  const interruptedCount = await taskAttempts.interruptAllWorking();
  if (interruptedCount > 0) {
    logger.info({ interruptedCount }, "recovery: attempts 'working' marcados como 'interrupted'");
  }
  const resumeDeps = { features, projects, featureRunner, logger, worktreesRoot };
  // awaiting_approval fica de fora: espera `apo approve|reject`, que retoma o
  // interrupt pelo checkpoint (M4.8).
  await resumeFeatures(
    resumeDeps,
    [
      "planning",
      "executing",
      "integrating",
      "validating",
      "reviewing",
      "fixing",
      "rejected",
      "delivering",
    ],
    "recovery",
  );

  // M3.9 — Features em paused_capacity voltam quando algum provider volta.
  startCapacityResumer({ ...resumeDeps, capacity, targets });

  const app = buildServer({
    logger,
    projects,
    projectAgents,
    features,
    tasks,
    taskAttempts,
    events,
    routingDecisions,
    handovers,
    qualityResults,
    featureRunner,
    targets,
    capacity,
    routingPolicy,
    worktreesRoot,
  });

  await app.listen({ path: socketPath });
  writePidFile(pidFilePath, process.pid);
  logger.info(
    { socketPath, pid: process.pid, targets: targets.map((entry) => entry.candidate.targetId) },
    "apo daemon iniciado",
  );

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
