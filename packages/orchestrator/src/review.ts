// Verificação de requisitos (M4.2) e Reviewer (M4.3) — seções 25 e 26 do
// PLAN.md. Os dois rodam read-only sobre a worktree de integração, depois que
// os gates passaram, e devolvem saída estruturada validada por zod.

import { execa } from "execa";
import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";
import { type RequirementCheck, type ReviewFinding, SEVERITIES } from "./completion.js";

export const RequirementsSchema = z.object({
  requirements: z
    .array(
      z.object({
        requirement: z.string().min(1),
        satisfied: z.boolean(),
        evidence: z.string().optional(),
      }),
    )
    .min(1),
});

export const ReviewSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(SEVERITIES),
      file: z.string().optional(),
      description: z.string().min(1),
      suggestedFix: z.string().optional(),
    }),
  ),
});

const DIFF_LIMIT = 60_000;

export async function integrationDiff(integrationPath: string, baseRef: string): Promise<string> {
  const { stdout } = await execa("git", ["diff", "--stat", "--patch", `${baseRef}...HEAD`], {
    cwd: integrationPath,
  });
  return stdout.length > DIFF_LIMIT
    ? `${stdout.slice(0, DIFF_LIMIT)}\n\n[diff truncado em ${DIFF_LIMIT} caracteres — leia os arquivos no repositório para o resto]`
    : stdout;
}

export interface ReviewContext {
  objective: string;
  diff: string;
  gatesSummary: string;
  cwd: string;
  timeoutMs: number;
}

export async function verifyRequirements(
  runner: AgentRunner,
  context: ReviewContext,
  signal: AbortSignal,
): Promise<{ checks?: RequirementCheck[]; error?: string }> {
  const result = await runner.run(
    "lead",
    {
      prompt: [
        "Verifique se a mudança abaixo atende ao objetivo da Feature.",
        "Quebre o objetivo em requisitos concretos e verificáveis e, para cada um, diga se o código",
        "atual (este diretório é a branch de integração) o atende, com a evidência (arquivo/trecho).",
        "Não invente requisitos que o objetivo não pede.",
        `Objetivo: ${context.objective}`,
        `Quality gates: ${context.gatesSummary}`,
        "Diff em relação à branch base:",
        context.diff,
      ].join("\n\n"),
      cwd: context.cwd,
      schema: RequirementsSchema,
      timeoutMs: context.timeoutMs,
    },
    signal,
  );
  if (result.outcome !== "success" || !result.output) {
    return { error: result.failure?.message ?? "verificação de requisitos falhou" };
  }
  return { checks: result.output.requirements };
}

export async function reviewIntegration(
  runner: AgentRunner,
  context: ReviewContext,
  signal: AbortSignal,
): Promise<{ findings?: ReviewFinding[]; error?: string }> {
  const result = await runner.run(
    "reviewer",
    {
      prompt: [
        "Revise a mudança abaixo (este diretório é a branch de integração; leia os arquivos que precisar).",
        "Procure: bugs, lacunas em relação ao objetivo, regressões, problemas de segurança, complexidade",
        "desnecessária, violações da arquitetura existente e testes faltando.",
        "Severidade: critical (quebra/segurança), high (bug provável), medium (deveria ser corrigido antes",
        "do merge), low (sugestão). Só reporte o que for acionável; lista vazia é uma resposta válida.",
        `Objetivo: ${context.objective}`,
        `Quality gates: ${context.gatesSummary}`,
        "Diff em relação à branch base:",
        context.diff,
      ].join("\n\n"),
      cwd: context.cwd,
      schema: ReviewSchema,
      timeoutMs: context.timeoutMs,
    },
    signal,
  );
  if (result.outcome !== "success" || !result.output) {
    return { error: result.failure?.message ?? "review falhou" };
  }
  return { findings: result.output.findings };
}
