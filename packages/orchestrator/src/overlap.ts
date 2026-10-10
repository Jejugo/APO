// FeatureOverlapCheck (M2.12/M2.13), seção 6.6 do TECHNICAL_PLAN.md.
//
// Só decide se vale perguntar ao usuário, nunca absorve sozinho:
// 1. determinística: interseção de expectedPaths (vazia → isolated, sem LLM);
// 2. semântica: o Lead julga se a interseção é relevante ou ruído.
// Falha do Lead conta como relevante: na dúvida, perguntar é barato.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export interface ActiveFeatureFootprint {
  featureId: string;
  objective: string;
  expectedPaths: string[];
}

export type FeatureOverlapResult =
  | { decision: "isolated"; sharedPaths: string[] }
  | {
      decision: "ask_user";
      overlappingFeatureId: string;
      overlappingObjective: string;
      sharedPaths: string[];
    };

function normalize(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Mesmo arquivo, ou um caminho é diretório do outro. */
function pathsCollide(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function sharedPathsOf(newPaths: string[], activePaths: string[]): string[] {
  const shared = new Set<string>();
  for (const candidate of newPaths) {
    for (const active of activePaths) {
      if (pathsCollide(candidate, active)) {
        shared.add(normalize(candidate.length <= active.length ? candidate : active));
      }
    }
  }
  return [...shared].sort();
}

const RelevanceSchema = z.object({
  relevant: z.boolean(),
  reason: z.string(),
});

export interface OverlapCheckInput {
  objective: string;
  expectedPaths: string[];
  active: ActiveFeatureFootprint[];
  runner?: AgentRunner;
  cwd: string;
  timeoutMs: number;
}

export async function checkFeatureOverlap(
  input: OverlapCheckInput,
  signal: AbortSignal,
): Promise<FeatureOverlapResult> {
  const collisions = input.active
    .map((feature) => ({
      feature,
      shared: sharedPathsOf(input.expectedPaths, feature.expectedPaths),
    }))
    .filter((collision) => collision.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length);

  for (const { feature, shared } of collisions) {
    if (!input.runner) {
      return {
        decision: "ask_user",
        overlappingFeatureId: feature.featureId,
        overlappingObjective: feature.objective,
        sharedPaths: shared,
      };
    }
    const result = await input.runner.run(
      "lead",
      {
        prompt: [
          "Duas mudanças no mesmo repositório tocam os mesmos caminhos. Decida se a sobreposição é relevante",
          "o bastante para perguntar ao usuário se o pedido novo deve ser absorvido pela Feature em andamento",
          "(ex.: mesma funcionalidade, uma depende da outra, editam o mesmo trecho) ou se é coincidência",
          "(ex.: as duas registram rotas diferentes no mesmo arquivo).",
          `Feature em andamento: ${feature.objective}`,
          `Pedido novo: ${input.objective}`,
          `Caminhos em comum: ${shared.join(", ")}`,
        ].join("\n"),
        cwd: input.cwd,
        schema: RelevanceSchema,
        timeoutMs: input.timeoutMs,
      },
      signal,
    );
    if (result.outcome !== "success" || !result.output || result.output.relevant) {
      return {
        decision: "ask_user",
        overlappingFeatureId: feature.featureId,
        overlappingObjective: feature.objective,
        sharedPaths: shared,
      };
    }
  }
  return { decision: "isolated", sharedPaths: [] };
}
