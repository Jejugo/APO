// Memória no fluxo da Feature (M5.9/M5.10). O orchestrator só conhece a porta;
// embeddings e pgvector ficam em @apo/memory, montado pelo daemon.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export const DISTILLED_KINDS = [
  "convention",
  "decision",
  "pattern",
  "failure",
  "correction",
] as const;

export interface MemoryPort {
  /** Bloco pronto para o prompt, ou undefined se nada relevante. */
  retrieveForPrompt(projectId: string, query: string): Promise<string | undefined>;
  remember(
    projectId: string,
    source: string,
    items: Array<{ kind: (typeof DISTILLED_KINDS)[number]; title: string; content: string }>,
  ): Promise<number>;
}

export const DistilledSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(DISTILLED_KINDS),
        title: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .max(8),
});

export interface FeatureRetrospective {
  objective: string;
  deliverySummary: string;
  findings: string[];
  corrections: string[];
  failures: string[];
}

/** M5.10 — o Lead destila o que vale lembrar em Features futuras. */
export async function distillMemories(
  runner: AgentRunner,
  retro: FeatureRetrospective,
  context: { cwd: string; timeoutMs: number },
  signal: AbortSignal,
) {
  const section = (title: string, items: string[]) =>
    `${title}:\n${items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (nenhum)"}`;
  const result = await runner.run(
    "lead",
    {
      prompt: [
        "Uma Feature deste projeto acabou de ser concluída. Registre o que vale lembrar em Features futuras,",
        "como memórias curtas e autossuficientes (0 a 8). Tipos:",
        "- convention: regra do projeto que o código deve seguir;",
        "- decision: decisão de design tomada e o motivo;",
        "- pattern: abordagem que funcionou bem aqui;",
        "- failure: tentativa que falhou e por quê (para não repetir);",
        "- correction: correção pedida pelo humano ou pelo review (o que estava errado e o certo).",
        "Não registre o óbvio, nem detalhes que só valem para esta Feature. Lista vazia é válida.",
        `Objetivo: ${retro.objective}`,
        section("Correções do humano (reject)", retro.corrections),
        section("Findings do review", retro.findings),
        section("Falhas de execução", retro.failures),
        `Resumo de entrega:\n${retro.deliverySummary}`,
      ].join("\n\n"),
      cwd: context.cwd,
      schema: DistilledSchema,
      timeoutMs: context.timeoutMs,
    },
    signal,
  );
  return result.outcome === "success" && result.output ? result.output.memories : undefined;
}
