// IntentTriage (ROADMAP.md seção 4.3). Passo determinístico antes de criar
// qualquer Feature: "question" nunca cria Feature/Task, só gera o evento leve
// `query.answered`; "bugfix"/"feature" entram no pipeline normal — a
// diferença entre os dois é o template de workflow (M2.10), não a
// arquitetura de execução.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export type Intent = "question" | "bugfix" | "feature";

const QUESTION_PATTERNS = [
  /^(o\s+que|por\s+que|porque|como|qual|quais|quando|onde|quem)\b/i,
  /^(what|why|how|when|where|who|which)\b/i,
  /\?\s*$/,
];

const BUGFIX_PATTERNS = [
  /\b(corrija|corrigir|conserte|consertar|arrume|arrumar|bug|erro|falha|quebrado|não\s+funciona)\b/i,
  /\b(fix|broken|doesn'?t\s+work|isn'?t\s+working|error|bug)\b/i,
];

const FEATURE_PATTERNS = [
  /\b(crie|criar|adicione|adicionar|implemente|implementar|construa|construir)\b/i,
  /\b(create|add|implement|build)\b/i,
];

/** Retorna `undefined` quando nenhuma regra determinística bate — caso ambíguo. */
export function classifyDeterministic(input: string): Intent | undefined {
  const text = input.trim();
  if (QUESTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return "question";
  }
  if (BUGFIX_PATTERNS.some((pattern) => pattern.test(text))) {
    return "bugfix";
  }
  if (FEATURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "feature";
  }
  return undefined;
}

const intentClassificationSchema = z.object({
  intent: z.enum(["question", "bugfix", "feature"]),
  reason: z.string(),
});

export type IntentTriageSource = "deterministic" | "lead" | "override";

export interface IntentTriageResult {
  intent: Intent;
  source: IntentTriageSource;
}

export interface IntentTriageOptions {
  /** Flag `--as question|bugfix|feature` — vence qualquer classificação. */
  override?: Intent;
  agentRunner: AgentRunner;
  cwd: string;
  timeoutMs: number;
}

export async function triageIntent(
  input: string,
  options: IntentTriageOptions,
  signal: AbortSignal,
): Promise<IntentTriageResult> {
  if (options.override) {
    return { intent: options.override, source: "override" };
  }

  const deterministic = classifyDeterministic(input);
  if (deterministic) {
    return { intent: deterministic, source: "deterministic" };
  }

  const result = await options.agentRunner.run(
    "lead",
    {
      prompt: `Classifique o pedido do usuário como "question" (pergunta ou leitura, não muda código), "bugfix" (corrige um comportamento quebrado) ou "feature" (funcionalidade nova). Pedido: "${input}"`,
      cwd: options.cwd,
      schema: intentClassificationSchema,
      timeoutMs: options.timeoutMs,
    },
    signal,
  );

  if (result.outcome === "success" && result.output) {
    return { intent: result.output.intent, source: "lead" };
  }

  throw new Error(
    `IntentTriage: não foi possível classificar o pedido automaticamente (${result.failure?.kind ?? "saída inválida"}). Use --as question|bugfix|feature para forçar.`,
  );
}
