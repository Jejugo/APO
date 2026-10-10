import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

export function writePidFile(path: string, pid: number): void {
  writeFileSync(path, String(pid), "utf8");
}

export function readPidFile(path: string): number | undefined {
  try {
    const content = readFileSync(path, "utf8").trim();
    const pid = Number(content);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Só remove se o pidfile ainda pertencer a este processo — evita apagar o de um daemon novo. */
export function removePidFileIfOwnedBy(path: string, pid: number): void {
  if (readPidFile(path) === pid) {
    try {
      unlinkSync(path);
    } catch {
      // já removido — ok
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonPidFilePath(apoHomeDir: string): string {
  return `${apoHomeDir}/daemon.pid`;
}
