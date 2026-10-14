// Finalidade dos targets (`bestFor` no config.yaml). `planning` reserva um target
// (ex.: Opus, GPT-Sol) para Lead, planner e Reviewer; os demais valores são dicas
// de complexidade para o Jev. Nada aqui é requisito: sem `bestFor` configurado,
// o comportamento é o de antes.

import type { ExecutionPreference } from "@apo/domain";
import {
  type ResolveInput,
  type ResolveResult,
  matchesPreference,
  resolveExecutionTarget,
} from "./resolver.js";
import type { RoutingCandidate, TargetPurpose } from "./types.js";

export function hasPurpose(candidate: RoutingCandidate, purpose: TargetPurpose): boolean {
  return candidate.bestFor?.includes(purpose) ?? false;
}

function isPlanningOnly(candidate: RoutingCandidate): boolean {
  const purposes = candidate.bestFor ?? [];
  return purposes.length > 0 && purposes.every((purpose) => purpose === "planning");
}

/**
 * Escolha por finalidade, do mais específico ao mais geral — o julgamento nunca
 * deixa de rodar por causa da finalidade:
 *   1. targets com `bestFor` contendo a finalidade;
 *   2. (fora de `planning`) targets de execução, sem os só de planejamento (custo);
 *   3. todos os candidatos.
 * `planning` (planner, replanejamento, perguntas, Reviewer) usa o 1º nível e cai
 * direto no 3º. `everyday` (triagem, sobreposição, resumos) nunca cai num target
 * só de planejamento se houver outro utilizável.
 */
export function resolveForPurpose(input: ResolveInput, purpose: TargetPurpose): ResolveResult {
  const tiers: RoutingCandidate[][] = [
    input.candidates.filter((candidate) => hasPurpose(candidate, purpose)),
    purpose === "planning" ? [] : executionCandidates(input.candidates),
  ];
  for (const candidates of tiers) {
    if (candidates.length === 0 || candidates.length === input.candidates.length) continue;
    const result = resolveExecutionTarget({ ...input, candidates });
    if (result.kind === "target") return result;
  }
  return resolveExecutionTarget(input);
}

/** Lead (planner, replanejamento), perguntas e Reviewer: o tier de planejamento. */
export function resolveForPlanning(input: ResolveInput): ResolveResult {
  return resolveForPurpose(input, "planning");
}

/**
 * Candidatos para executar Tasks: targets só de planejamento não pegam Tasks
 * comuns (custo), a menos que sejam tudo o que existe ou que uma preferência
 * explícita (Task, Feature ou role) aponte para eles — o filtro vale só para a
 * escolha automática.
 */
export function executionCandidates<T extends RoutingCandidate>(
  candidates: T[],
  preferences: Array<ExecutionPreference | null | undefined> = [],
): T[] {
  const explicit = preferences.filter(
    (preference): preference is ExecutionPreference => !!preference && preference.mode !== "auto",
  );
  const rest = candidates.filter(
    (candidate) =>
      !isPlanningOnly(candidate) ||
      explicit.some((preference) => matchesPreference(candidate, preference)),
  );
  return rest.length > 0 ? rest : candidates;
}
