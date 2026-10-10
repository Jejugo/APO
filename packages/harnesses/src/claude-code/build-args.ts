// Construção de argumentos da CLI do Claude Code — flags confirmadas no
// spike M0.9 (spikes/claude-code.md). Mantém o conhecimento de flags isolado
// deste arquivo (regra 4 do PLAN.md).

import type { AgentExecutionInput } from "../types.js";

export function buildClaudeCodeArgs(
  input: AgentExecutionInput,
  resumeSessionId?: string,
): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--permission-prompts",
    "none",
    // Decisão M1 (TECHNICAL_PLAN.md seção 6.1): isola CLAUDE.md/hooks pessoais
    // do operador sem quebrar a auth OAuth (diferente de --bare, que exige
    // ANTHROPIC_API_KEY/apiKeyHelper).
    "--setting-sources",
    "",
    "--permission-mode",
    input.mode === "read-only" ? "plan" : "acceptEdits",
  ];

  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.outputSchema) {
    args.push("--json-schema", JSON.stringify(input.outputSchema));
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  // Por último: `--add-dir` é variádico no Claude Code e engoliria flags seguintes.
  if (input.extraWritableDirs && input.extraWritableDirs.length > 0) {
    args.push("--add-dir", ...input.extraWritableDirs);
  }

  return args;
}
