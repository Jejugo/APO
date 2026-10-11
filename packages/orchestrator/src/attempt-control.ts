// Controle de cancelamento por attempt. Viaja por `configurable` do invoke(),
// nunca pelo `signal` de nível top (achado do M1: aquele signal aborta a
// invocação inteira do LangGraph e pula verify/complete).
//
// Um AbortController por Task em execução: no M2 várias Tasks rodam ao mesmo
// tempo, e um reroute manual (M3.10) mira uma Task só. `cancel()` derruba
// todas e qualquer attempt futuro desta invocação.

import type { ExecutionPreference } from "@apo/domain";

export type AttemptAbortReason =
  | { type: "cancel" }
  | { type: "reroute"; preference: ExecutionPreference };

export class AttemptControl {
  private readonly controllers = new Map<string, AbortController>();
  private cancelled = false;
  /** Para chamadas de julgamento do graph (review, Lead), que não são attempts. */
  private readonly feature = new AbortController();

  /** Chamado no início de cada attempt de uma Task. */
  newAttempt(taskId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    if (this.cancelled) {
      controller.abort({ type: "cancel" } satisfies AttemptAbortReason);
    }
    return controller.signal;
  }

  attemptFinished(taskId: string): void {
    this.controllers.delete(taskId);
  }

  featureSignal(): AbortSignal {
    return this.feature.signal;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    this.cancelled = true;
    this.feature.abort({ type: "cancel" } satisfies AttemptAbortReason);
    for (const controller of this.controllers.values()) {
      controller.abort({ type: "cancel" } satisfies AttemptAbortReason);
    }
  }

  /** Interrompe só o attempt atual da Task. Retorna false se ela não está rodando. */
  reroute(taskId: string, preference: ExecutionPreference): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort({ type: "reroute", preference } satisfies AttemptAbortReason);
    return true;
  }
}

export function abortReasonOf(signal: AbortSignal): AttemptAbortReason | undefined {
  const reason = signal.reason as AttemptAbortReason | undefined;
  return reason && (reason.type === "cancel" || reason.type === "reroute") ? reason : undefined;
}
