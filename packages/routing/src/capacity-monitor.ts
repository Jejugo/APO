// CapacityMonitor (M3.3): estado por provider, atualizado de forma **reativa**
// a partir das falhas classificadas pelos harnesses. Sem fonte oficial de
// uso, `usagePercent` fica vazio (seção 15 do PLAN.md).
//
// - rate_limited     → degraded até o resetAt
// - quota_exhausted  → exhausted até o resetAt
// - auth             → exhausted (credencial inválida) até o resetAt estimado
// - crash/timeout/stalled → não muda disponibilidade (problema da Task, não do
//   provider), só conta como falha recente para desempate
// - após o resetAt   → volta a `unknown`
// - sucesso          → `available`, mas só de trabalho que começou depois da
//   última mudança de estado: um attempt que já estava rodando quando a quota
//   acabou pode terminar bem e não prova que ela voltou (achado do E2E do M4).
//
// Quando o provider não informa quando volta, usamos um resetAt **estimado**
// (`unknownResetRetryMs`) só para não deixar o provider bloqueado para sempre;
// isso é marcado em `resetAtEstimated`.

import type { ProviderId } from "@apo/domain";
import type { CapacityFailureKind, ProviderCapacitySnapshot } from "./types.js";

export interface CapacitySink {
  onChange(snapshot: ProviderCapacitySnapshot): void | Promise<void>;
}

export interface CapacityMonitorOptions {
  sink?: CapacitySink;
  now?: () => Date;
  unknownResetRetryMs?: number;
  /** Janela em que uma falha conta como "recente" para desempate. */
  recentFailureWindowMs?: number;
}

interface ProviderState {
  availability: ProviderCapacitySnapshot["availability"];
  usagePercent?: number | undefined;
  resetAt?: Date | undefined;
  resetAtEstimated?: boolean | undefined;
  reason?: string | undefined;
  activeWorkers: number;
  failureTimes: number[];
  capturedAt: Date;
}

export class CapacityMonitor {
  private readonly states = new Map<ProviderId, ProviderState>();
  private readonly now: () => Date;
  private readonly unknownResetRetryMs: number;
  private readonly recentFailureWindowMs: number;

  constructor(private readonly options: CapacityMonitorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.unknownResetRetryMs = options.unknownResetRetryMs ?? 30 * 60_000;
    this.recentFailureWindowMs = options.recentFailureWindowMs ?? 30 * 60_000;
  }

  /** Carrega o estado persistido (ex.: `provider_capacity` no boot do daemon). */
  load(snapshots: Array<Omit<ProviderCapacitySnapshot, "activeWorkers" | "recentFailures">>): void {
    for (const snapshot of snapshots) {
      this.states.set(snapshot.provider, {
        availability: snapshot.availability,
        ...(snapshot.usagePercent !== undefined ? { usagePercent: snapshot.usagePercent } : {}),
        ...(snapshot.resetAt !== undefined ? { resetAt: snapshot.resetAt } : {}),
        ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
        activeWorkers: 0,
        failureTimes: [],
        capturedAt: snapshot.capturedAt,
      });
    }
  }

  get(provider: ProviderId): ProviderCapacitySnapshot {
    const state = this.state(provider);
    const now = this.now();
    if (
      (state.availability === "degraded" || state.availability === "exhausted") &&
      state.resetAt !== undefined &&
      state.resetAt.getTime() <= now.getTime()
    ) {
      state.availability = "unknown";
      state.reason = "resetAt atingido";
      state.resetAt = undefined;
      state.resetAtEstimated = undefined;
      state.capturedAt = now;
      void this.options.sink?.onChange(this.toSnapshot(provider, state));
    }
    return this.toSnapshot(provider, state);
  }

  all(providers: ProviderId[]): ProviderCapacitySnapshot[] {
    return providers.map((provider) => this.get(provider));
  }

  recordFailure(
    provider: ProviderId,
    failure: { kind: CapacityFailureKind; message: string; resetAt?: Date },
  ): void {
    const state = this.state(provider);
    const now = this.now();
    state.failureTimes.push(now.getTime());

    const capacityKind =
      failure.kind === "rate_limited"
        ? "degraded"
        : failure.kind === "quota_exhausted" || failure.kind === "auth"
          ? "exhausted"
          : undefined;
    if (!capacityKind) {
      return;
    }

    state.availability = capacityKind;
    state.reason = `${failure.kind}: ${failure.message.slice(0, 300)}`;
    if (failure.resetAt) {
      state.resetAt = failure.resetAt;
      state.resetAtEstimated = undefined;
    } else {
      state.resetAt = new Date(now.getTime() + this.unknownResetRetryMs);
      state.resetAtEstimated = true;
    }
    state.capturedAt = now;
    void this.options.sink?.onChange(this.toSnapshot(provider, state));
  }

  /** `startedAt`: início do trabalho que deu certo (ausente = agora). */
  recordSuccess(provider: ProviderId, startedAt?: Date): void {
    const state = this.state(provider);
    if (state.availability === "available") {
      return;
    }
    const limited = state.availability === "degraded" || state.availability === "exhausted";
    if (limited && startedAt && startedAt.getTime() <= state.capturedAt.getTime()) {
      return;
    }
    state.availability = "available";
    state.resetAt = undefined;
    state.resetAtEstimated = undefined;
    state.reason = undefined;
    state.capturedAt = this.now();
    void this.options.sink?.onChange(this.toSnapshot(provider, state));
  }

  workerStarted(provider: ProviderId): void {
    this.state(provider).activeWorkers += 1;
  }

  workerFinished(provider: ProviderId): void {
    const state = this.state(provider);
    state.activeWorkers = Math.max(0, state.activeWorkers - 1);
  }

  /** Menor resetAt entre os providers indisponíveis — quando vale tentar de novo (M3.9). */
  earliestReset(providers: ProviderId[]): Date | undefined {
    let earliest: Date | undefined;
    for (const provider of providers) {
      const resetAt = this.get(provider).resetAt;
      if (resetAt && (!earliest || resetAt < earliest)) {
        earliest = resetAt;
      }
    }
    return earliest;
  }

  private state(provider: ProviderId): ProviderState {
    let state = this.states.get(provider);
    if (!state) {
      state = {
        availability: "unknown",
        activeWorkers: 0,
        failureTimes: [],
        capturedAt: this.now(),
      };
      this.states.set(provider, state);
    }
    return state;
  }

  private toSnapshot(provider: ProviderId, state: ProviderState): ProviderCapacitySnapshot {
    const cutoff = this.now().getTime() - this.recentFailureWindowMs;
    state.failureTimes = state.failureTimes.filter((time) => time >= cutoff);
    return {
      provider,
      availability: state.availability,
      ...(state.usagePercent !== undefined ? { usagePercent: state.usagePercent } : {}),
      ...(state.resetAt !== undefined ? { resetAt: state.resetAt } : {}),
      ...(state.resetAtEstimated ? { resetAtEstimated: true } : {}),
      ...(state.reason !== undefined ? { reason: state.reason } : {}),
      activeWorkers: state.activeWorkers,
      recentFailures: state.failureTimes.length,
      capturedAt: state.capturedAt,
    };
  }
}
