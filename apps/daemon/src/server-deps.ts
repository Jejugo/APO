import type {
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
  targets: TargetRegistry;
  capacity: CapacityMonitor;
  routingPolicy: RoutingPolicy;
  worktreesRoot: string;
}
