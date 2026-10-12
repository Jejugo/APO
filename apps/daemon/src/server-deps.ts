import type {
  ConversationRepository,
  EventRepository,
  FeatureRepository,
  HandoverRepository,
  ProjectAgentRepository,
  ProjectRepository,
  QualityResultRepository,
  RoutingDecisionRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { MemoryService, RetrieveOptions } from "@apo/memory";
import type { Logger } from "@apo/observability";
import type { TargetRegistry } from "@apo/orchestrator";
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
  /** M6.9: detalhes do `/health` (Postgres, providers, Jev, memória). */
  health?: () => Promise<Record<string, unknown>>;
}
