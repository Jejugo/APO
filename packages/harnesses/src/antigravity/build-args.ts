// Argumentos do `agy` (Antigravity CLI) — flags confirmadas no spike M2.23
// (spikes/antigravity.md). Conhecimento de flags isolado aqui (regra 4 do PLAN.md).
//
// Sem `--dangerously-skip-permissions`, em headless o worker só edita arquivos
// (todo comando de shell é negado). Com a flag, roda comandos (testes, install,
// git) — mas sem nenhum confinamento: o spike mostrou escrita fora do cwd, e
// `--sandbox` não impediu isso. Por isso é opt-in por target no config.yaml.

import type { AgentExecutionInput } from "../types.js";

export interface AntigravityArgsOptions {
  dangerouslySkipPermissions?: boolean;
}

export function buildAntigravityArgs(
  input: AgentExecutionInput,
  resumeConversationId?: string,
  options: AntigravityArgsOptions = {},
): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--mode",
    input.mode === "read-only" ? "plan" : "accept-edits",
    "--disable-slash-commands",
  ];
  // Nunca em read-only: liberaria escrita numa Task que só deveria ler.
  if (options.dangerouslySkipPermissions && input.mode === "workspace-write") {
    args.push("--dangerously-skip-permissions");
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (resumeConversationId) {
    args.push("--conversation", resumeConversationId);
  }
  for (const dir of input.extraWritableDirs ?? []) {
    args.push("--add-dir", dir);
  }
  return args;
}
