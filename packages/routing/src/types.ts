import type { HarnessId, ProviderId } from "@apo/domain";

/** Um target do `config.yaml` (M3.2). O id distingue dois targets com o mesmo harness. */
export interface RoutingCandidate {
  targetId: string;
  provider: ProviderId;
  harness: HarnessId;
  model?: string;
}

export type ProviderAvailability = "available" | "degraded" | "exhausted" | "unknown";

/** Seção 15 do PLAN.md. `usagePercent` só existe com fonte oficial — nunca inventado. */
export interface ProviderCapacitySnapshot {
  provider: ProviderId;
  availability: ProviderAvailability;
  usagePercent?: number;
  resetAt?: Date;
  /** `true` quando o resetAt não veio do provider e é só o momento de tentar de novo. */
  resetAtEstimated?: boolean;
  reason?: string;
  activeWorkers: number;
  recentFailures: number;
  capturedAt: Date;
}

/** Subconjunto do `FailureKind` dos harnesses que interessa à capacidade. */
export type CapacityFailureKind =
  | "rate_limited"
  | "quota_exhausted"
  | "auth"
  | "timeout"
  | "stalled"
  | "crash"
  | "cancelled"
  | "invalid_output";

export interface RoutingPolicy {
  capacityAware: boolean;
  degradedAt: number;
  avoidAt: number;
  preferLowerUsageDifference: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  capacityAware: true,
  degradedAt: 80,
  avoidAt: 95,
  preferLowerUsageDifference: 20,
};
