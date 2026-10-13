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
    // stream-json (com --verbose, exigido pelo CLI): um evento por linha
    // enquanto o agente trabalha — o `apo task tail` mostra isso ao vivo. O
    // último evento (`type: "result"`) é o mesmo objeto do `--output-format json`.
    "--output-format",
    "stream-json",
    "--verbose",
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
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  if (input.outputSchema) {
    args.push("--json-schema", JSON.stringify(input.outputSchema));
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  // Worker de escrita roda comandos (testes, build, lint, install). Sem isto,
  // com `--permission-prompts none` todo Bash é negado e o worker entrega sem
  // testar (achado pelo `apo task tail`). Read-only (Lead/Reviewer/Task read)
  // continua sem comandos. Na VM, o sandbox do systemd confina a escrita.
  // Antes do --add-dir: ambos são variádicos, e o --add-dir fica por último.
  if (input.mode === "workspace-write") {
    args.push("--allowedTools", "Bash");
  }
  // Por último: `--add-dir` é variádico no Claude Code e engoliria flags seguintes.
  if (input.extraWritableDirs && input.extraWritableDirs.length > 0) {
    args.push("--add-dir", ...input.extraWritableDirs);
  }

  return args;
}
