import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apoHome, daemonPidFilePath, isProcessAlive, readPidFile } from "@apo/config";
import type { Command } from "commander";
import { DaemonUnavailableError, daemonRequest } from "../daemon-client.js";

function daemonEntryPath(): string {
  // apps/cli/dist/commands/daemon.js -> ../../../daemon/dist/main.js (monorepo dev).
  return fileURLToPath(new URL("../../../daemon/dist/main.js", import.meta.url));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await daemonRequest("/health");
      return true;
    } catch {
      await delay(200);
    }
  }
  return false;
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command("daemon").description("Gerencia o processo do apo daemon");

  daemon
    .command("start")
    .description("Inicia o daemon em background")
    .action(async () => {
      const pidFilePath = daemonPidFilePath(apoHome());
      const existingPid = readPidFile(pidFilePath);
      if (existingPid !== undefined && isProcessAlive(existingPid)) {
        console.log(`apo daemon já está rodando (pid ${existingPid})`);
        return;
      }

      const logDir = join(apoHome(), "logs");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, "daemon.log");
      // stdio nunca pode ser "ignore" — sem isso, qualquer erro do daemon
      // (ex.: o AgentRunner/graph falhando) desaparece sem deixar rastro,
      // tornando o problema impossível de depurar (TECHNICAL_PLAN.md seção
      // 3.2, ~/.apo/logs/ já previa isso).
      const logFd = openSync(logPath, "a");
      const child = spawn(process.execPath, [daemonEntryPath()], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();

      const healthy = await waitForHealth(10_000);
      if (healthy) {
        console.log(`apo daemon iniciado. Logs em ${logPath}.`);
      } else {
        console.error(`apo daemon não respondeu a tempo. Veja ${logPath}.`);
        process.exitCode = 1;
      }
    });

  daemon
    .command("status")
    .description("Mostra o status do daemon")
    .action(async () => {
      try {
        const health = await daemonRequest<{ status: string; pid: number; uptimeMs: number }>(
          "/health",
        );
        console.log(`rodando — pid ${health.pid}, uptime ${Math.round(health.uptimeMs / 1000)}s`);
      } catch (error) {
        if (error instanceof DaemonUnavailableError) {
          console.log("parado");
        } else {
          throw error;
        }
      }
    });

  daemon
    .command("stop")
    .description("Encerra o daemon")
    .action(async () => {
      const pidFilePath = daemonPidFilePath(apoHome());
      const pid = readPidFile(pidFilePath);
      if (pid === undefined || !isProcessAlive(pid)) {
        console.log("apo daemon não está rodando.");
        return;
      }
      process.kill(pid, "SIGTERM");

      const deadline = Date.now() + 10_000;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await delay(200);
      }
      if (isProcessAlive(pid)) {
        console.error("apo daemon não encerrou a tempo.");
        process.exitCode = 1;
      } else {
        console.log("apo daemon encerrado.");
      }
    });
}
