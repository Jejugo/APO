// PromptBuilder (M2.16) — ordem fixa da seção 6.7 do TECHNICAL_PLAN.md:
//   1. Role.systemPrompt (identidade e convenções)
//   2. contrato padrão do worker (não negociável)
//   3. contexto da Task (objetivo, artefatos das dependências, handover)

import type { RoleDefinition } from "@apo/config";
import { type TaskHandoverPayload, renderHandoverForPrompt } from "./handover.js";

export interface DependencyContext {
  title: string;
  summary: string | null;
  artifacts: unknown;
}

export interface WorkerPromptInput {
  role: RoleDefinition;
  featureObjective: string;
  task: { title: string; description: string; kind: "read" | "write" };
  dependencies: DependencyContext[];
  handover?: TaskHandoverPayload;
  /** Caminho do WorkerReport — fora do repo (seção 6.3). */
  resultPath?: string;
}

export const WORKER_CONTRACT = [
  "## Contrato do worker (APO)",
  "- Trabalhe apenas no diretório atual. Ele é uma worktree git isolada para esta Task.",
  "- Faça commit do seu trabalho na branch atual quando terminar.",
  "- Não peça confirmação: não há humano acompanhando esta sessão.",
].join("\n");

function reportInstructions(resultPath: string): string {
  return [
    `Ao terminar, escreva um JSON em ${resultPath} com o formato:`,
    '{"summary": "o que foi feito, em 1-3 frases", "artifacts": { ... }}',
    "Use `artifacts` para tudo que outra Task vai precisar consumir (ex.: contrato de API, nomes de",
    "funções/rotas criadas). Esse arquivo fica fora do repositório: não o commite.",
    "Se descobrir que falta trabalho fora do escopo desta Task para o objetivo da Feature, não o faça:",
    'peça em `"planChangeRequests": [{"title": "...", "description": "...", "reason": "..."}]`.',
  ].join("\n");
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const sections: string[] = [input.role.systemPrompt.trim(), WORKER_CONTRACT];

  const context = [
    "## Sua Task",
    `Objetivo geral da Feature: ${input.featureObjective}`,
    `Task: ${input.task.title}`,
    input.task.description,
  ];
  if (input.task.kind === "read") {
    context.push("Esta Task é de leitura/análise: não altere arquivos.");
  }
  sections.push(context.join("\n"));

  if (input.dependencies.length > 0) {
    const deps = input.dependencies.map((dep) => {
      const lines = [`### ${dep.title}`];
      if (dep.summary) lines.push(dep.summary);
      if (dep.artifacts !== null && dep.artifacts !== undefined) {
        lines.push("Artefatos:", "```json", JSON.stringify(dep.artifacts, null, 2), "```");
      }
      return lines.join("\n");
    });
    sections.push(
      [
        "## Resultado das Tasks de que você depende",
        "O código delas já está nesta branch.",
        ...deps,
      ].join("\n\n"),
    );
  }

  if (input.handover) {
    sections.push(renderHandoverForPrompt(input.handover));
  }
  if (input.resultPath) {
    sections.push(reportInstructions(input.resultPath));
  }
  return sections.join("\n\n");
}
