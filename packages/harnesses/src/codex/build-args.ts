// Construção de argumentos da CLI do Codex — flags confirmadas no spike
// M0.10 (spikes/codex.md). Mantém o conhecimento de flags isolado deste
// arquivo (regra 4 do PLAN.md).
//
// Achados que moldam esta função:
// - `-s/--sandbox` não é aceito em `codex exec resume` (erro: "unexpected
//   argument '-s' found") — no resume, sandbox/rede são re-especificados via
//   `-c sandbox_mode="..."`, senão o resume herda a política mais restritiva.
// - `workspace-write` bloqueia rede por padrão; liberar com
//   `-c sandbox_workspace_write.network_access=true`.
// - `--ignore-user-config` neutraliza `~/.codex/config.toml`/`hooks.json` do
//   operador (decisão M1, TECHNICAL_PLAN.md seção 6.1).

import type { AgentExecutionInput } from "../types.js";

export interface CodexArgsOptions {
  outputLastMessagePath: string;
  outputSchemaPath?: string;
  resumeThreadId?: string;
}

export function buildCodexArgs(input: AgentExecutionInput, options: CodexArgsOptions): string[] {
  const sandboxMode = input.mode === "read-only" ? "read-only" : "workspace-write";

  const sandboxArgs = options.resumeThreadId
    ? ["-c", `sandbox_mode="${sandboxMode}"`]
    : ["-s", sandboxMode];

  const networkArgs =
    input.mode === "workspace-write" && input.networkAccess
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : [];

  const base = options.resumeThreadId
    ? ["exec", "resume", options.resumeThreadId, input.prompt]
    : ["exec", input.prompt];

  const args = [
    ...base,
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-o",
    options.outputLastMessagePath,
    ...sandboxArgs,
    ...networkArgs,
  ];

  if (input.model) {
    args.push("-m", input.model);
  }
  // `--ignore-user-config` ignora o config.toml, então o esforço vai por -c.
  if (input.effort) {
    args.push("-c", `model_reasoning_effort="${input.effort}"`);
  }
  if (options.outputSchemaPath) {
    args.push("--output-schema", options.outputSchemaPath);
  }
  for (const dir of input.extraWritableDirs ?? []) {
    args.push("--add-dir", dir);
  }

  return args;
}
