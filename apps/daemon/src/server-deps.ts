import type {
  AgentMessageRepository,
  ConversationRepository,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectAgentRepository,
  ProjectRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  SettingsRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { MemoryService, RetrieveOptions } from "@apo/memory";
import type { Logger } from "@apo/observability";
import type { MemoryPort, TargetRegistry } from "@apo/orchestrator";
import type { CapacityMonitor, RoutingPolicy } from "@apo/routing";
import type { FeatureRunner } from "./feature-runner.js";

export interface ServerDeps {
  logger: Logger;
  projects: ProjectRepository;
  projectAgents: ProjectAgentRepository;
  features: FeatureRepository;
  tasks: TaskRepository;
  taskAttempts: TaskAttemptRepository;
  events: EventRepository;
  routingDecisions: RoutingDecisionRepository;
  handovers: HandoverRepository;
  qualityResults: QualityResultRepository;
  featureRunner: FeatureRunner;
  /** M7: perguntas (agent_messages) e o modo global (settings). */
  agentMessages: AgentMessageRepository;
  settings: SettingsRepository;
  /** M7: grava a decisão como memória do Project. */
  memoryPort?: MemoryPort;
  conversations: ConversationRepository;
  /** M5: ausente quando `memory.enabled: false`. */
  memory?: MemoryService;
  memoryRetrieve?: RetrieveOptions;
  targets: TargetRegistry;
  capacity: CapacityMonitor;
  routingPolicy: RoutingPolicy;
  worktreesRoot: string;
  /** Caminho do log de um attempt (o mesmo que o runner usa) — `apo task tail`. */
  attemptLogPath?: (attemptId: string) => string;
  /** Log dos quality gates de uma iteração da Feature — `apo watch` (tecla `g`). */
  gateLogPath?: (featureId: string, iteration: number) => string;
  /** M6.9: detalhes do `/health` (Postgres, providers, Jev, memória). */
  health?: () => Promise<Record<string, unknown>>;
}
