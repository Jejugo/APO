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
  ConversationRepository,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectAgentRepository,
  ProjectRepository,
  ProviderCapacityRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  SettingsRepository,
  TaskAttemptRepository,
  TaskRepository,
  createDb,
} from "@apo/db";
import { buildWorkerEnvironment } from "@apo/harnesses";
import {
  MemoryService,
  MemoryStore,
  TransformersEmbeddingProvider,
  renderMemories,
} from "@apo/memory";
import { createLogger } from "@apo/observability";
import { type MemoryPort, WorkerSlots } from "@apo/orchestrator";
import {
  DEFAULT_ROUTING_POLICY,
  JevTaskRouter,
  type RoutingPolicy,
  type TaskRouter,
} from "@apo/routing";
import { sql } from "drizzle-orm";
import { createCapacityMonitor } from "./capacity.js";
import { killOrphanWorkers, removeOrphanWorktrees } from "./cleanup.js";
import { FeatureRunner } from "./feature-runner.js";
import { resumeFeatures, startCapacityResumer } from "./resume.js";
import { loadSecretsFile } from "./secrets.js";
import { type ServerDeps, buildServer } from "./server.js";
import { buildTargetRegistry } from "./targets.js";

const DEFAULT_DATABASE_URL = "postgres://apo:apo@localhost:5433/apo";

async function main(): Promise<void> {
  const secrets = loadSecretsFile(join(apoHome(), "secrets.env"));
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
  if (secrets.warning) logger.warn(secrets.warning);

  // M5 — Jev como TaskRouter. Sem key ou desligado, o RuleBasedRouter decide
  // sozinho: o Jev nunca é requisito estrutural (M5.4).
  const jevConfig = GlobalConfigSchema.shape.jev.parse(globalConfig.jev ?? {});
  let taskRouter: TaskRouter | undefined;
  const jevKey = process.env[jevConfig.apiKeyEnv ?? "OPENROUTER_API_KEY"];
  if (jevConfig.enabled === false) {
    logger.info("Jev desligado no config.yaml; roteamento só por regras");
  } else if (!jevKey) {
    logger.warn(
      { apiKeyEnv: jevConfig.apiKeyEnv },
      "Jev sem API key (nem no ambiente nem em ~/.apo/secrets.env); roteamento só por regras",
    );
  } else {
    taskRouter = new JevTaskRouter({
      endpoint: jevConfig.endpoint ?? "https://openrouter.ai/api/alpha/decisions",
      model: jevConfig.model ?? "~typesafe/jev-latest",
      apiKey: jevKey,
      timeoutMs: jevConfig.timeoutMs ?? 15_000,
    });
  }
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
  const settings = new SettingsRepository(db);

  // M5.6–M5.10 — memória do Project. Embeddings locais (ADR 0004); o modelo
  // carrega em segundo plano para a primeira Feature não pagar os ~7s.
  const memoryConfig = GlobalConfigSchema.shape.memory.parse(globalConfig.memory ?? {});
  let memory: MemoryService | undefined;
  let memoryPort: MemoryPort | undefined;
  if (memoryConfig.enabled !== false) {
    const embeddings = new TransformersEmbeddingProvider({ cacheDir: join(apoHome(), "models") });
    memory = new MemoryService(new MemoryStore(db, embeddings));
    const service = memory;
    const retrieveOptions = {
      limit: memoryConfig.topK ?? 6,
      maxChars: memoryConfig.maxChars ?? 6000,
    };
    memoryPort = {
      retrieveForPrompt: async (projectId, query) =>
        renderMemories(await service.retrieve(projectId, query, retrieveOptions)),
      remember: (projectId, source, items) => service.remember(projectId, source, items),
    };
    void embeddings.embed(["aquecimento"], "query").catch((error: unknown) => {
      logger.warn({ error }, "memória: falha ao carregar o modelo de embeddings");
    });
  }

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

  const attemptLogPath = (attemptId: string) =>
    join(apoHome(), "logs", "attempts", `${attemptId}.log`);

  const gateLogPath = (featureId: string, iteration: number) =>
    join(apoHome(), "logs", "gates", `${featureId}-${iteration}.log`);

  const reviewLogPath = (featureId: string, iteration: number) =>
    join(apoHome(), "logs", "review", `${featureId}-${iteration}.log`);

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
      settings,
      ...(taskRouter ? { taskRouter } : {}),
      ...(memoryPort ? { memory: memoryPort } : {}),
      routingPolicy,
      // M3.0b: allowlist base + o que o Project autorizar em .apo/project.yaml.
      workerEnv: (repoPath) => {
        const projectConfig = loadConfig(
          join(repoPath, ".apo", "project.yaml"),
          ProjectConfigSchema,
        );
        return buildWorkerEnvironment(projectConfig.worker?.env?.allow ?? []);
      },
      attemptLogPath,
      gateLogPath,
      reviewLogPath,
      runsRoot: join(apoHome(), "runs"),
      stallTimeoutMs: (limits?.stallTimeoutMinutes ?? 10) * 60_000,
      // M2.4: compartilhado entre todas as Features do daemon.
      slots: new WorkerSlots(limits?.maxGlobalWorkers ?? 4, limits?.maxWorkersPerProvider ?? 2),
    },
    databaseUrl,
  );
  await featureRunner.setup();

  // M6.8 — antes do recovery: workers órfãos de um daemon que caiu e
  // worktrees de Features que já terminaram.
  await killOrphanWorkers(join(apoHome(), "runs"), worktreesRoot, logger);
  await removeOrphanWorktrees({ features, projects, logger }, worktreesRoot);

  // M1.13 — Recovery: nenhum attempt "working" sobrevive a um restart; Features
  // ativas retomam re-invocando o graph (nodes idempotentes).
  const interruptedCount = await taskAttempts.interruptAllWorking();
  if (interruptedCount > 0) {
    logger.info({ interruptedCount }, "recovery: attempts 'working' marcados como 'interrupted'");
  }
  const resumeDeps = { features, projects, featureRunner, logger, worktreesRoot, events };
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

  const serverDeps: ServerDeps = {
    attemptLogPath,
    gateLogPath,
    reviewLogPath,
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
    conversations: new ConversationRepository(db),
    agentMessages,
    settings,
    ...(memoryPort ? { memoryPort } : {}),
    ...(memory
      ? {
          memory,
          memoryRetrieve: {
            limit: memoryConfig.topK ?? 6,
            maxChars: memoryConfig.maxChars ?? 6000,
          },
        }
      : {}),
    targets,
    capacity,
    routingPolicy,
    worktreesRoot,
    health: async () => {
      let postgres = "ok";
      try {
        await db.execute(sql`select 1`);
      } catch (error) {
        postgres = error instanceof Error ? error.message : String(error);
      }
      return {
        postgres,
        providers: targets.map((entry) => {
          const snapshot = capacity.get(entry.candidate.provider);
          return {
            target: entry.candidate.targetId,
            availability: snapshot.availability,
            activeWorkers: snapshot.activeWorkers,
            ...(snapshot.resetAt ? { resetAt: snapshot.resetAt.toISOString() } : {}),
          };
        }),
        taskRouter: taskRouter?.id ?? "rule",
        memory: memory ? "on" : "off",
      };
    },
  };
  const app = buildServer(serverDeps);
  await app.listen({ path: socketPath });

  // M6.7 — listener TCP com token (IP do Tailscale). Sem token, não sobe.
  const remoteConfig = GlobalConfigSchema.shape.remote.parse(globalConfig.remote ?? {});
  let remoteApp: ReturnType<typeof buildServer> | undefined;
  if (remoteConfig.listen) {
    const remoteToken = process.env[remoteConfig.tokenEnv ?? "APO_REMOTE_TOKEN"];
    if (!remoteToken || remoteToken.length < 24) {
      logger.error(
        { tokenEnv: remoteConfig.tokenEnv },
        "remote.listen configurado sem token (mínimo 24 caracteres); listener TCP não iniciado",
      );
    } else {
      const [host, port] = [
        remoteConfig.listen.slice(0, remoteConfig.listen.lastIndexOf(":")),
        Number(remoteConfig.listen.slice(remoteConfig.listen.lastIndexOf(":") + 1)),
      ];
      const remote = buildServer(serverDeps, { authToken: remoteToken });
      remoteApp = remote;
      // No boot da VM o IP do Tailscale pode ainda não existir: tenta de novo
      // em segundo plano em vez de derrubar o daemon (o socket local já serve).
      const listenRemote = async (attempt: number): Promise<void> => {
        try {
          await remote.listen({ host, port });
          logger.info({ host, port }, "listener remoto (com token) ativo");
        } catch (error) {
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
          logger.warn(
            { error, host, port, retryInMs: delay },
            "listener remoto indisponível; tentando de novo",
          );
          setTimeout(() => void listenRemote(attempt + 1), delay).unref();
        }
      };
      void listenRemote(0);
    }
  }
  writePidFile(pidFilePath, process.pid);
  logger.info(
    {
      socketPath,
      pid: process.pid,
      targets: targets.map((entry) => entry.candidate.targetId),
      taskRouter: taskRouter?.id ?? "rule",
    },
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
    await remoteApp?.close();
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
