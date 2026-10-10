// Ciclo de vida de uma Feature no SingleAgentEngine: rodar, cancelar
// (M1.16), reroute manual (M3.10) e retomar depois de um restart (M1.13) ou
// de uma pausa por capacidade (M3.9).
//
// O controle de cancelamento viaja em `configurable.attemptControl`, nunca no
// `signal` de nível top do invoke() — ver packages/orchestrator/src/attempt-control.ts.

import type { ExecutionPreference } from "@apo/domain";
import {
  AttemptControl,
  type FeatureGraph,
  type FeatureGraphDeps,
  type FeatureGraphInput,
  buildFeatureGraph,
} from "@apo/orchestrator";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export type FeatureRunInput = FeatureGraphInput;

export class FeatureRunner {
  private readonly controls = new Map<string, AttemptControl>();
  private readonly checkpointer: PostgresSaver;
  private graph: FeatureGraph | undefined;

  constructor(
    private readonly graphDeps: FeatureGraphDeps,
    databaseUrl: string,
  ) {
    this.checkpointer = PostgresSaver.fromConnString(databaseUrl);
  }

  async setup(): Promise<void> {
    await this.checkpointer.setup();
    this.graph = buildFeatureGraph(this.graphDeps, this.checkpointer);
  }

  /** Fire-and-forget pelo chamador — não bloqueia a resposta HTTP. */
  async run(input: FeatureRunInput): Promise<void> {
    if (!this.graph) {
      throw new Error("FeatureRunner.setup() precisa ser chamado antes de run()");
    }
    if (this.controls.has(input.featureId)) {
      return;
    }
    const control = new AttemptControl();
    this.controls.set(input.featureId, control);
    try {
      await this.graph.invoke(input, {
        configurable: { thread_id: input.featureId, attemptControl: control },
      });
    } finally {
      this.controls.delete(input.featureId);
    }
  }

  cancel(featureId: string): boolean {
    const control = this.controls.get(featureId);
    if (!control) return false;
    control.cancel();
    return true;
  }

  /** M3.10: interrompe o attempt atual; o graph continua no target pedido. */
  reroute(featureId: string, preference: ExecutionPreference): boolean {
    const control = this.controls.get(featureId);
    if (!control) return false;
    control.reroute(preference);
    return true;
  }

  isRunning(featureId: string): boolean {
    return this.controls.has(featureId);
  }
}
