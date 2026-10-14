// IntentTriage (ROADMAP.md seção 4.3). Passo determinístico antes de criar
// qualquer Feature: "question" nunca cria Feature/Task, só gera o evento leve
// `query.answered`; "bugfix"/"feature" entram no pipeline normal — a
// diferença entre os dois é o template de workflow (M2.10), não a
// arquitetura de execução. "document" (plano, análise, relatório) produz só um
// documento: sem quality gates e sem rodadas automáticas de correção.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export type Intent = "question" | "document" | "bugfix" | "feature";

const QUESTION_PATTERNS = [
  /^(o\s+que|por\s+que|porque|como|qual|quais|quando|onde|quem)\b/i,
  /^(what|why|how|when|where|who|which)\b/i,
  /\?\s*$/,
];

// Pedido cujo produto é um texto, não código. Se o pedido também manda
// implementar, é uma feature: a guarda abaixo evita tratar "escreva o plano e
// implemente" como documento.
const DOCUMENT_PATTERNS = [
  /\b(escreva|redija|elabore|produza|gere|monte|fa[cç]a)\b[^.\n]{0,60}\b(plano|documento|relat[óo]rio|an[aá]lise|especifica[cç][aã]o|spec|adr|rfc|proposta|invent[aá]rio)\b/i,
  /\b(write|draft|produce|prepare)\b[^.\n]{0,60}\b(plan|document|report|analysis|spec|adr|rfc|proposal)\b/i,
  /\b(somente|apenas)\s+(um\s+)?(documento|plano|relat[óo]rio|an[aá]lise)\b/i,
  /\bonly\s+(a\s+)?(document|plan|report|analysis)\b/i,
  /\bplano\s+t[ée]cnico\b/i,
];
const IMPLEMENT_PATTERNS = [/\b(implemente|implementar|construa|construir|implement|build)\b/i];

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
  if (
    DOCUMENT_PATTERNS.some((pattern) => pattern.test(text)) &&
    !IMPLEMENT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return "document";
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
  intent: z.enum(["question", "document", "bugfix", "feature"]),
  reason: z.string(),
});

export type IntentTriageSource = "deterministic" | "lead" | "override";

export interface IntentTriageResult {
  intent: Intent;
  source: IntentTriageSource;
}

export interface IntentTriageOptions {
  /** Flag `--as question|document|bugfix|feature` — vence qualquer classificação. */
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
      prompt: `Classifique o pedido do usuário como "question" (pergunta ou leitura, não muda código), "document" (o produto é um texto: plano, análise, relatório, especificação; não muda código de produção), "bugfix" (corrige um comportamento quebrado) ou "feature" (funcionalidade nova). Na dúvida entre "document" e "feature", pergunte-se: o pedido manda mudar o comportamento do sistema? Se não, é "document". Pedido: "${input}"`,
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
    `IntentTriage: não foi possível classificar o pedido automaticamente (${result.failure?.kind ?? "saída inválida"}). Use --as question|document|bugfix|feature para forçar.`,
  );
}
