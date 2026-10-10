import type {
  EventRepository,
  FeatureRepository,
  ProjectAgentRepository,
  ProjectRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { Logger } from "@apo/observability";
import type { HarnessRegistry } from "@apo/orchestrator";
import type { FeatureRunner } from "./feature-runner.js";

export interface ServerDeps {
  logger: Logger;
  projects: ProjectRepository;
  projectAgents: ProjectAgentRepository;
  features: FeatureRepository;
  tasks: TaskRepository;
  taskAttempts: TaskAttemptRepository;
  events: EventRepository;
  featureRunner: FeatureRunner;
  harnessRegistry: HarnessRegistry;
  worktreesRoot: string;
}
