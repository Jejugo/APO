// M5 — os 6 casos da Phase 6 contra o Jev REAL (custo real, ~US$ 0,00002 por
// chamada). Só roda com APO_LIVE_JEV=1 e OPENROUTER_API_KEY no ambiente:
//   set -a; . ~/.apo/secrets.env; set +a; APO_LIVE_JEV=1 pnpm vitest run src/jev.live.test.ts

import type { ProviderId } from "@apo/domain";
import { describe, expect, it } from "vitest";
import { JevTaskRouter } from "./jev.js";
import { resolveExecutionTarget } from "./resolver.js";
import type { SemanticRoutingInput } from "./semantic.js";
import type { ProviderCapacitySnapshot, RoutingCandidate } from "./types.js";

const LIVE = process.env.APO_LIVE_JEV === "1" && Boolean(process.env.OPENROUTER_API_KEY);

// Dois targets tecnicamente equivalentes (mesmo tipo de agente), providers distintos.
const A: RoutingCandidate = {
  targetId: "agent-a",
  provider: "openai",
  harness: "fake",
  model: "frontier-coder",
};
const B: RoutingCandidate = {
  targetId: "agent-b",
  provider: "anthropic",
  harness: "fake",
  model: "frontier-coder",
};

function snap(
  provider: ProviderId,
  extra: Partial<ProviderCapacitySnapshot> = {},
): ProviderCapacitySnapshot {
  return {
    provider,
    availability: "available",
    activeWorkers: 0,
    recentFailures: 0,
    capturedAt: new Date(),
    ...extra,
  };
}

function input(
  task: { title: string; description: string; expectedPaths?: string[] },
  capacity: Record<string, Partial<ProviderCapacitySnapshot>> = {},
): SemanticRoutingInput {
  return {
    task: { kind: "write", origin: "plan", expectedPaths: [], ...task },
    project: { name: "loja-web" },
    candidates: [A, B].map((candidate) => ({
      candidate,
      capabilities: { readOnly: true, structuredOutput: true },
      capacity: snap(candidate.provider, capacity[candidate.targetId] ?? {}),
    })),
  };
}

describe.skipIf(!LIVE)("JevTaskRouter — Jev real (Phase 6)", () => {
  const router = new JevTaskRouter({
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "~typesafe/jev-latest",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    timeoutMs: 30_000,
  });
  const signal = new AbortController().signal;

  async function decide(routingInput: SemanticRoutingInput) {
    const semantic = await router.route(routingInput, signal);
    const capacity = (provider: ProviderId) =>
      routingInput.candidates.find((entry) => entry.candidate.provider === provider)?.capacity ??
      snap(provider);
    const resolved = resolveExecutionTarget({ candidates: [A, B], capacity, semantic });
    console.log(
      JSON.stringify({
        task: routingInput.task.title,
        semantic,
        final: resolved.kind === "target" ? resolved.target.targetId : resolved.kind,
        reason: resolved.reason,
      }),
    );
    return { semantic, resolved };
  }

  it("simple task → complexidade baixa", async () => {
    const { semantic } = await decide(
      input({
        title: "Corrigir typo no README",
        description: "Trocar 'recieve' por 'receive' em README.md",
        expectedPaths: ["README.md"],
      }),
    );
    expect(semantic.complexity).toBe("low");
  }, 60_000);

  it("complex task → complexidade alta", async () => {
    const { semantic } = await decide(
      input({
        title: "Reescrever o carrinho com estado offline-first",
        description:
          "Trocar o estado do carrinho por um modelo offline-first com sincronização e resolução de conflitos entre abas e dispositivos, migrando os 14 componentes que usam o carrinho.",
        expectedPaths: ["src/cart/", "src/sync/", "src/components/"],
      }),
    );
    expect(semantic.complexity).toBe("high");
  }, 60_000);

  it("high-risk task → risco alto", async () => {
    const { semantic } = await decide(
      input({
        title: "Trocar o fluxo de pagamento",
        description:
          "Migrar a captura de cartão para o novo gateway de pagamentos, incluindo estorno e armazenamento de tokens.",
        expectedPaths: ["src/payments/"],
      }),
    );
    expect(semantic.risk).toBe("high");
  }, 60_000);

  it("GATE: A em 80% e B em 40%, equivalentes → tende a B", async () => {
    const { resolved } = await decide(
      input(
        {
          title: "Adicionar filtro por categoria na listagem de produtos",
          description: "Filtro por categoria na página /produtos, com teste.",
          expectedPaths: ["src/pages/produtos.tsx"],
        },
        { "agent-a": { usagePercent: 80 }, "agent-b": { usagePercent: 40 } },
      ),
    );
    expect(resolved).toMatchObject({ kind: "target", target: B });
  }, 60_000);

  it("provider exhausted → nunca escolhido", async () => {
    const { resolved } = await decide(
      input(
        {
          title: "Adicionar ordenação por preço",
          description: "Ordenar produtos por preço na listagem.",
          expectedPaths: ["src/pages/produtos.tsx"],
        },
        { "agent-b": { availability: "exhausted" } },
      ),
    );
    expect(resolved).toMatchObject({ kind: "target", target: A });
  }, 60_000);

  it("provider unknown → continua elegível e a decisão sai", async () => {
    const { semantic, resolved } = await decide(
      input(
        {
          title: "Adicionar paginação",
          description: "Paginação de 20 itens na listagem de produtos.",
          expectedPaths: ["src/pages/produtos.tsx"],
        },
        { "agent-a": { availability: "unknown" }, "agent-b": { availability: "unknown" } },
      ),
    );
    expect(semantic.ranking).toHaveLength(2);
    expect(resolved.kind).toBe("target");
  }, 60_000);
});
