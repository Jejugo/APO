// Controle de cancelamento por attempt. Viaja por `configurable` do invoke(),
// nunca pelo `signal` de nível top (achado do M1: aquele signal aborta a
// invocação inteira do LangGraph e pula verify/complete).
//
// Precisa ser por attempt, não por Feature: um reroute manual (M3.10) aborta o
// attempt atual e o graph continua num attempt novo, com outro target. Um
// signal único por Feature já estaria abortado no attempt seguinte.

import type { ExecutionPreference } from "@apo/domain";

export type AttemptAbortReason =
  | { type: "cancel" }
  | { type: "reroute"; preference: ExecutionPreference };

export class AttemptControl {
  private controller = new AbortController();
  private cancelled = false;

  /** Chamado pelo node 'execute' no início de cada attempt. */
  newAttempt(): AbortSignal {
    this.controller = new AbortController();
    if (this.cancelled) {
      this.controller.abort({ type: "cancel" } satisfies AttemptAbortReason);
    }
    return this.controller.signal;
  }

  /** Cancela a Feature: o attempt atual e qualquer attempt futuro desta invocação. */
  cancel(): void {
    this.cancelled = true;
    this.controller.abort({ type: "cancel" } satisfies AttemptAbortReason);
  }

  /** Interrompe só o attempt atual; o graph segue com um novo attempt no target pedido. */
  reroute(preference: ExecutionPreference): void {
    this.controller.abort({ type: "reroute", preference } satisfies AttemptAbortReason);
  }
}

export function abortReasonOf(signal: AbortSignal): AttemptAbortReason | undefined {
  const reason = signal.reason as AttemptAbortReason | undefined;
  return reason && (reason.type === "cancel" || reason.type === "reroute") ? reason : undefined;
}
