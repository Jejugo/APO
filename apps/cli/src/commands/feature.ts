import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface FeatureRow {
  id: string;
  projectId: string;
  objective: string;
  intent: string;
  status: string;
}

export function registerFeatureCommands(program: Command): void {
  const feature = program.command("feature").description("Consulta Features");

  feature
    .command("list")
    .description("Lista Features de um Project")
    .requiredOption("--project <id>", "id do Project")
    .action(async (options: { project: string }) => {
      const rows = await daemonRequest<FeatureRow[]>(
        `/features?projectId=${encodeURIComponent(options.project)}`,
      );
      if (rows.length === 0) {
        console.log("Nenhuma feature encontrada.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  [${row.status}]  ${row.objective}`);
      }
    });

  feature
    .command("show <id>")
    .description("Mostra os detalhes de uma Feature")
    .action(async (id: string) => {
      const row = await daemonRequest<FeatureRow>(`/features/${id}`);
      console.log(JSON.stringify(row, null, 2));
    });

  feature
    .command("preference <id>")
    .description("Define a preferência de execução da Feature (vale a partir do próximo attempt)")
    .requiredOption("--mode <mode>", "forced | preferred | auto")
    .option("--harness <harness>", "claude-code | codex")
    .option("--provider <provider>", "anthropic | openai | google")
    .action(async (id: string, options: { mode: string; harness?: string; provider?: string }) => {
      const row = await daemonRequest<FeatureRow & { executionPreference: unknown }>(
        `/features/${id}/preference`,
        {
          method: "POST",
          body: {
            mode: options.mode,
            ...(options.harness ? { harness: options.harness } : {}),
            ...(options.provider ? { provider: options.provider } : {}),
          },
        },
      );
      console.log(`Preferência de ${row.id}: ${JSON.stringify(row.executionPreference ?? "auto")}`);
    });
}
