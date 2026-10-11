// Segredos do daemon (M5.1): `~/.apo/secrets.env`, uma linha KEY=VALUE por
// segredo, chmod 600. Vai só para o process.env do daemon — os workers nunca
// herdam isso (allowlist de ambiente, M3.0b). Variável já definida no ambiente
// tem prioridade sobre o arquivo.

import { readFileSync, statSync } from "node:fs";

export interface SecretsLoadResult {
  loaded: string[];
  warning?: string;
}

export function loadSecretsFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretsLoadResult {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { loaded: [] };
  }
  const loaded: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  // Permissão larga não impede o boot, mas fica registrada.
  const mode = statSync(path).mode & 0o777;
  return mode & 0o077
    ? { loaded, warning: `${path} tem permissão ${mode.toString(8)}; use chmod 600` }
    : { loaded };
}
