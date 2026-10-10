import type { ProviderId } from "@apo/domain";
import { describe, expect, it } from "vitest";
import { CapacityMonitor } from "./capacity-monitor.js";
import { resolveExecutionTarget } from "./resolver.js";
import { routeTask } from "./rule-based-router.js";
import type { ProviderAvailability, ProviderCapacitySnapshot, RoutingCandidate } from "./types.js";

const CLAUDE: RoutingCandidate = {
  targetId: "claude-code",
  provider: "anthropic",
  harness: "claude-code",
};
const CODEX: RoutingCandidate = { targetId: "codex", provider: "openai", harness: "codex" };
const CANDIDATES = [CLAUDE, CODEX];

function capacity(
  states: Partial<Record<ProviderId, Partial<ProviderCapacitySnapshot>>>,
): (provider: ProviderId) => ProviderCapacitySnapshot {
  return (provider) => ({
    provider,
    availability: "unknown",
    activeWorkers: 0,
    recentFailures: 0,
    capturedAt: new Date(0),
    ...states[provider],
  });
}

describe("routeTask (RuleBasedRouter)", () => {
  it("PLAN.md seção 18: A em 80% e B em 40%, equivalentes → B", () => {
    const result = routeTask({
      candidates: [CODEX, CLAUDE],
      capacity: capacity({
        openai: { availability: "available", usagePercent: 80 },
        anthropic: { availability: "available", usagePercent: 40 },
      }),
    });
    expect(result.target?.targetId).toBe("claude-code");
  });

  it("elimina provider esgotado", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({ anthropic: { availability: "exhausted" } }),
    });
    expect(result.target?.targetId).toBe("codex");
  });

  it("prefere unknown/available a degraded", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({ anthropic: { availability: "degraded" } }),
    });
    expect(result.target?.targetId).toBe("codex");
  });

  it("usa um degraded quando é o único que sobrou", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({
        anthropic: { availability: "degraded" },
        openai: { availability: "exhausted" },
      }),
    });
    expect(result.target?.targetId).toBe("claude-code");
  });

  it("desempata por workers ativos", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({ anthropic: { activeWorkers: 2 } }),
    });
    expect(result.target?.targetId).toBe("codex");
  });

  it("todos esgotados → sem target", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({
        anthropic: { availability: "exhausted" },
        openai: { availability: "exhausted" },
      }),
    });
    expect(result.target).toBeUndefined();
  });

  it("respeita exclude", () => {
    const result = routeTask({
      candidates: CANDIDATES,
      capacity: capacity({}),
      exclude: ["claude-code"],
    });
    expect(result.target?.targetId).toBe("codex");
  });
});

describe("resolveExecutionTarget — matriz forced/preferred/auto × disponibilidade", () => {
  const forcedClaude = { mode: "forced", harness: "claude-code" } as const;
  const preferredClaude = { mode: "preferred", harness: "claude-code" } as const;

  const cases: Array<[string, ProviderAvailability, string]> = [
    ["forced", "available", "target:claude-code"],
    ["forced", "degraded", "needs_human"],
    ["forced", "exhausted", "needs_human"],
    ["preferred", "available", "target:claude-code"],
    ["preferred", "degraded", "target:codex"],
    ["preferred", "exhausted", "target:codex"],
    ["auto", "available", "target:claude-code"],
    ["auto", "degraded", "target:codex"],
    ["auto", "exhausted", "target:codex"],
  ];

  it.each(cases)("%s com claude %s → %s", (mode, availability, expected) => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({ anthropic: { availability } }),
      taskPreference:
        mode === "forced" ? forcedClaude : mode === "preferred" ? preferredClaude : null,
    });
    const summary = result.kind === "target" ? `target:${result.target.targetId}` : result.kind;
    expect(summary).toBe(expected);
  });

  it("Task override vence Feature override", () => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({}),
      taskPreference: { mode: "forced", harness: "codex" },
      featurePreference: { mode: "forced", harness: "claude-code" },
    });
    expect(result.kind === "target" && result.target.targetId).toBe("codex");
    expect(result.kind === "target" && result.resolutionSource).toBe("task_override");
  });

  it("Role preference vale quando Task e Feature não definem nada", () => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({}),
      rolePreference: { mode: "preferred", harness: "codex" },
    });
    expect(result.kind === "target" && result.target.targetId).toBe("codex");
    expect(result.kind === "target" && result.resolutionSource).toBe("role_preference");
  });

  it("Feature override vence Role preference", () => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({}),
      featurePreference: { mode: "forced", harness: "claude-code" },
      rolePreference: { mode: "forced", harness: "codex" },
    });
    expect(result.kind === "target" && result.target.targetId).toBe("claude-code");
  });

  it("forced nunca troca de provider, mesmo com exclude", () => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({}),
      featurePreference: forcedClaude,
      exclude: ["claude-code"],
    });
    expect(result.kind === "target" && result.target.targetId).toBe("claude-code");
  });

  it("todos esgotados em auto → no_capacity", () => {
    const result = resolveExecutionTarget({
      candidates: CANDIDATES,
      capacity: capacity({
        anthropic: { availability: "exhausted" },
        openai: { availability: "exhausted" },
      }),
    });
    expect(result.kind).toBe("no_capacity");
  });
});

describe("CapacityMonitor", () => {
  it("rate_limited → degraded e volta a unknown depois do resetAt", () => {
    let now = new Date(2026, 0, 1, 10, 0, 0);
    const monitor = new CapacityMonitor({ now: () => now });
    monitor.recordFailure("openai", {
      kind: "rate_limited",
      message: "429",
      resetAt: new Date(2026, 0, 1, 10, 5, 0),
    });
    expect(monitor.get("openai").availability).toBe("degraded");
    now = new Date(2026, 0, 1, 10, 6, 0);
    expect(monitor.get("openai").availability).toBe("unknown");
  });

  it("quota sem resetAt informado ganha um resetAt estimado — nunca fica bloqueado para sempre", () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const monitor = new CapacityMonitor({ now: () => now, unknownResetRetryMs: 60_000 });
    monitor.recordFailure("anthropic", { kind: "quota_exhausted", message: "usage limit" });
    const snapshot = monitor.get("anthropic");
    expect(snapshot.availability).toBe("exhausted");
    expect(snapshot.resetAtEstimated).toBe(true);
    expect(snapshot.resetAt).toEqual(new Date(2026, 0, 1, 10, 1, 0));
  });

  it("crash não muda disponibilidade, só conta falha recente", () => {
    const monitor = new CapacityMonitor();
    monitor.recordFailure("openai", { kind: "crash", message: "boom" });
    const snapshot = monitor.get("openai");
    expect(snapshot.availability).toBe("unknown");
    expect(snapshot.recentFailures).toBe(1);
  });

  it("nunca inventa usagePercent", () => {
    const monitor = new CapacityMonitor();
    monitor.recordSuccess("anthropic");
    expect(monitor.get("anthropic").usagePercent).toBeUndefined();
  });
});
