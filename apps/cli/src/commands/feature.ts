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
}
