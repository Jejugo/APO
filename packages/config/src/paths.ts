import { homedir } from "node:os";
import { join } from "node:path";

/** Expande um `~` inicial para o home do usuário — `GlobalConfigSchema` usa `~/...` como default. */
export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function apoHome(): string {
  return join(homedir(), ".apo");
}

export function globalConfigPath(): string {
  return join(apoHome(), "config.yaml");
}
