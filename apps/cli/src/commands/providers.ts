import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface ProviderRow {
  targetId: string;
  provider: string;
  availability: string;
  usagePercent: number | null;
  resetAt: string | null;
  resetAtEstimated: boolean;
  reason: string | null;
  activeWorkers: number;
  recentFailures: number;
}

export function registerProvidersCommand(program: Command): void {
  program
    .command("providers")
    .description("Capacidade atual de cada target (nunca inventa percentual de uso)")
    .action(async () => {
      const rows = await daemonRequest<ProviderRow[]>("/providers");
      for (const row of rows) {
        const usage = row.usagePercent === null ? "uso: desconhecido" : `uso: ${row.usagePercent}%`;
        const reset = row.resetAt
          ? `  volta: ${new Date(row.resetAt).toLocaleString()}${row.resetAtEstimated ? " (estimado)" : ""}`
          : "";
        console.log(
          `${row.targetId.padEnd(12)} ${row.provider.padEnd(10)} ${row.availability.padEnd(10)} ${usage}  workers: ${row.activeWorkers}${reset}`,
        );
        if (row.reason) {
          console.log(`${"".padEnd(12)} motivo: ${row.reason}`);
        }
      }
    });
}
