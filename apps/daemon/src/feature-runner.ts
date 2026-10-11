// Ciclo de vida de uma Feature no ApoNativeEngine: rodar, cancelar
// (M1.16), reroute manual (M3.10) e retomar depois de um restart (M1.13) ou
// de uma pausa por capacidade (M3.9).
//
// O controle de cancelamento viaja em `configurable.attemptControl`, nunca no
// `signal` de nível top do invoke() — ver packages/orchestrator/src/attempt-control.ts.

import type { ExecutionPreference } from "@apo/domain";
import {
  type ApprovalDecision,
  AttemptControl,
  type FeatureGraph,
  type FeatureGraphDeps,
  type FeatureGraphInput,
  buildFeatureGraph,
} from "@apo/orchestrator";
import { Command } from "@langchain/langgraph";
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
    await this.invoke(input.featureId, input);
  }

  /**
   * M4.8: responde ao interrupt do node await_approval. Funciona depois de um
   * restart: o ponto de parada está no checkpoint do Postgres.
   */
  async resume(featureId: string, decision: ApprovalDecision): Promise<void> {
    await this.invoke(featureId, new Command({ resume: decision }));
  }

  private async invoke(
    featureId: string,
    input: Parameters<FeatureGraph["invoke"]>[0],
  ): Promise<void> {
    if (!this.graph) {
      throw new Error("FeatureRunner.setup() precisa ser chamado antes de run()");
    }
    if (this.controls.has(featureId)) {
      return;
    }
    const control = new AttemptControl();
    this.controls.set(featureId, control);
    try {
      await this.graph.invoke(input, {
        configurable: { thread_id: featureId, attemptControl: control },
      });
    } finally {
      this.controls.delete(featureId);
    }
  }

  cancel(featureId: string): boolean {
    const control = this.controls.get(featureId);
    if (!control) return false;
    control.cancel();
    return true;
  }

  /**
   * M3.10: interrompe o attempt atual da Task; ela continua no target pedido.
   * `false` = a Task não tem attempt rodando agora (o chamador grava o override).
   */
  reroute(featureId: string, taskId: string, preference: ExecutionPreference): boolean {
    return this.controls.get(featureId)?.reroute(taskId, preference) ?? false;
  }

  isRunning(featureId: string): boolean {
    return this.controls.has(featureId);
  }
}
