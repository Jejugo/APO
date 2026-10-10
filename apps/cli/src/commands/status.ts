import type { Command } from "commander";
import { DaemonUnavailableError, daemonRequest } from "../daemon-client.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Status rápido do daemon")
    .action(async () => {
      try {
        const health = await daemonRequest<{ status: string; pid: number; uptimeMs: number }>(
          "/health",
        );
        console.log(
          `apo daemon rodando — pid ${health.pid}, uptime ${Math.round(health.uptimeMs / 1000)}s`,
        );
      } catch (error) {
        if (error instanceof DaemonUnavailableError) {
          console.log("apo daemon parado. Rode 'apo daemon start'.");
        } else {
          throw error;
        }
      }
    });
}
