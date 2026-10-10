// Monta o registry concreto de harnesses (algo que packages/orchestrator
// nunca pode fazer — regra 4 do PLAN.md, verificado pelo teste de
// arquitetura M1.14) e expõe o ciclo de vida de uma Feature: rodar, cancelar
// (M1.16) e retomar depois de um restart do daemon (M1.13).

import type {
  EventRepository,
  FeatureRepository,
  TaskAttemptRepository,
  TaskRepository,
} from "@apo/db";
import type { HarnessId } from "@apo/domain";
import type { Logger } from "@apo/observability";
import { type FeatureGraph, type HarnessRegistry, buildFeatureGraph } from "@apo/orchestrator";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export interface FeatureRunInput {
  featureId: string;
  projectId: string;
  repoPath: string;
  defaultBranch: string;
  objective: string;
  harness: HarnessId;
  worktreesRoot: string;
}

export interface FeatureRunnerDeps {
  logger: Logger;
  features: FeatureRepository;
  tasks: TaskRepository;
  taskAttempts: TaskAttemptRepository;
  events: EventRepository;
  databaseUrl: string;
  harnessRegistry: HarnessRegistry;
}

export class FeatureRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly checkpointer: PostgresSaver;
  private graph: FeatureGraph | undefined;

  constructor(private readonly deps: FeatureRunnerDeps) {
    this.checkpointer = PostgresSaver.fromConnString(deps.databaseUrl);
  }

  async setup(): Promise<void> {
    await this.checkpointer.setup();
    this.graph = buildFeatureGraph(
      {
        logger: this.deps.logger,
        features: this.deps.features,
        tasks: this.deps.tasks,
        taskAttempts: this.deps.taskAttempts,
        events: this.deps.events,
        harnessRegistry: this.deps.harnessRegistry,
      },
      this.checkpointer,
    );
  }

  /**
   * Fire-and-forget pelo chamador (rota HTTP) — não bloqueia a resposta da
   * criação da Feature.
   *
   * O `AbortSignal` do cancelamento vai só em `configurable.cancelSignal`,
   * nunca no `signal` de nível top do `invoke()`. Achado real: `signal` ali é
   * o próprio LangGraph quem interpreta — abortar aquele signal aborta a
   * invocação inteira, pulando 'verify'/'complete' e deixando a Feature sem
   * nenhum status terminal nunca escrito. `configurable` é passado adiante
   * sem ser interpretado pelo runtime, só o node 'execute' (feature-graph.ts)
   * o lê para cancelar a chamada do harness — o resto do graph roda normal.
   */
  async run(input: FeatureRunInput): Promise<void> {
    if (!this.graph) {
      throw new Error("FeatureRunner.setup() precisa ser chamado antes de run()");
    }
    const controller = new AbortController();
    this.controllers.set(input.featureId, controller);
    try {
      await this.graph.invoke(input, {
        configurable: { thread_id: input.featureId, cancelSignal: controller.signal },
      });
    } finally {
      this.controllers.delete(input.featureId);
    }
  }

  /** M1.16: interrompe o attempt ativo via o mesmo AbortSignal que o harness recebe. */
  cancel(featureId: string): boolean {
    const controller = this.controllers.get(featureId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  isRunning(featureId: string): boolean {
    return this.controllers.has(featureId);
  }
}
