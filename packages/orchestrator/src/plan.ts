// Planner (M2.5) e templates de workflow (M2.10).
//
// O Lead propõe o DAG; a validação é determinística (ids únicos, dependências
// existentes, sem ciclo). Plano inválido ou falha do Lead → fallback de uma
// Task só, igual ao M1 — a Feature nunca trava por causa do planner.

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export const PlannedTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["read", "write"]),
  role: z.string().min(1),
  expectedPaths: z.array(z.string()),
  dependsOn: z.array(z.string()),
});

export const FeaturePlanSchema = z.object({
  tasks: z.array(PlannedTaskSchema).min(1),
});

export type PlannedTask = z.infer<typeof PlannedTaskSchema>;
export type FeaturePlan = z.infer<typeof FeaturePlanSchema>;

export type PlanValidation = { ok: true } | { ok: false; reason: string };

export function validatePlan(plan: FeaturePlan): PlanValidation {
  const keys = new Set<string>();
  for (const task of plan.tasks) {
    if (keys.has(task.key)) return { ok: false, reason: `key duplicada: ${task.key}` };
    keys.add(task.key);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!keys.has(dep))
        return { ok: false, reason: `${task.key} depende de ${dep}, que não existe` };
      if (dep === task.key) return { ok: false, reason: `${task.key} depende de si mesma` };
    }
  }
  try {
    planWaves(plan.tasks);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  return { ok: true };
}

/** Ondas topológicas: cada onda só depende de ondas anteriores. Lança em ciclo. */
export function planWaves<T extends { key: string; dependsOn: string[] }>(tasks: T[]): T[][] {
  const remaining = new Map(tasks.map((task) => [task.key, task]));
  const done = new Set<string>();
  const waves: T[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((task) =>
      task.dependsOn.every((dep) => done.has(dep)),
    );
    if (wave.length === 0) {
      throw new Error(`ciclo de dependências entre: ${[...remaining.keys()].join(", ")}`);
    }
    for (const task of wave) {
      remaining.delete(task.key);
      done.add(task.key);
    }
    waves.push(wave);
  }
  return waves;
}

export function singleTaskPlan(objective: string): FeaturePlan {
  return {
    tasks: [
      {
        key: "t1",
        title: objective.slice(0, 120),
        description: objective,
        kind: "write",
        role: "generic",
        expectedPaths: [],
        dependsOn: [],
      },
    ],
  };
}

// M2.10 — templates como dados (seção 21 do PLAN.md), não como código.
export const WORKFLOW_TEMPLATES = {
  feature:
    "Feature: quebre em Tasks pequenas por responsabilidade (ex.: backend, frontend, testes). " +
    "Tasks independentes não dependem umas das outras e rodam em paralelo. Uma Task que consome " +
    "o contrato de outra depende dela. Prefira 1 a 5 Tasks; não crie Tasks de 'revisão' ou 'planejamento'.",
  bugfix:
    "Bugfix: normalmente UMA Task que reproduz o bug com um teste e corrige. Só divida se a correção " +
    "tocar áreas realmente independentes.",
  document:
    "Documento: o produto é UM texto (plano, análise, relatório), não código. Planeje UMA Task " +
    "(kind write) que escreve o arquivo pedido e não altera mais nada; só divida se o pedido listar " +
    "documentos independentes. Não crie Tasks de código, de teste nem de revisão.",
} as const;

export interface PlanFeatureInput {
  objective: string;
  intent: keyof typeof WORKFLOW_TEMPLATES;
  roleIds: string[];
  cwd: string;
  timeoutMs: number;
  /** M5.9: memória do projeto relevante para o objetivo. */
  memory?: string;
}

export interface PlanFeatureResult {
  plan: FeaturePlan;
  source: "lead" | "fallback";
  reason?: string;
}

export async function planFeature(
  runner: AgentRunner,
  input: PlanFeatureInput,
  signal: AbortSignal,
): Promise<PlanFeatureResult> {
  const prompt = [
    "Planeje a execução do objetivo abaixo como um DAG de Tasks para workers de código.",
    WORKFLOW_TEMPLATES[input.intent],
    `Roles válidos (use exatamente um destes ids em "role"): ${input.roleIds.join(", ")}.`,
    'Cada Task tem: key curta e única (t1, t2…), title, description autossuficiente, kind ("write" se altera arquivos, "read" se só analisa), role, expectedPaths (caminhos relativos ao repo que você espera que a Task altere; pode ser vazio para read) e dependsOn (keys das Tasks das quais ela precisa do resultado).',
    "Leia o repositório o suficiente para estimar expectedPaths de forma realista.",
    ...(input.memory ? [input.memory] : []),
    `Objetivo: ${input.objective}`,
  ].join("\n\n");

  const result = await runner.run(
    "lead",
    { prompt, cwd: input.cwd, schema: FeaturePlanSchema, timeoutMs: input.timeoutMs },
    signal,
  );
  if (result.outcome !== "success" || !result.output) {
    return {
      plan: singleTaskPlan(input.objective),
      source: "fallback",
      reason: `planner falhou: ${result.failure?.kind ?? "saída inválida"}`,
    };
  }
  const validation = validatePlan(result.output);
  if (!validation.ok) {
    return {
      plan: singleTaskPlan(input.objective),
      source: "fallback",
      reason: `plano inválido: ${validation.reason}`,
    };
  }
  return { plan: result.output, source: "lead" };
}
