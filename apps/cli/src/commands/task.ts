import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface TaskRow {
  id: string;
  featureId: string;
  title: string;
  status: string;
}

export function registerTaskCommands(program: Command): void {
  const task = program.command("task").description("Consulta Tasks");

  task
    .command("list")
    .description("Lista as Tasks de uma Feature")
    .requiredOption("--feature <id>", "id da Feature")
    .action(async (options: { feature: string }) => {
      const rows = await daemonRequest<TaskRow[]>(`/features/${options.feature}/tasks`);
      if (rows.length === 0) {
        console.log("Nenhuma task encontrada.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  [${row.status}]  ${row.title}`);
      }
    });

  task
    .command("show <id>")
    .description("Mostra os detalhes de uma Task")
    .action(async (id: string) => {
      const row = await daemonRequest<TaskRow>(`/tasks/${id}`);
      console.log(JSON.stringify(row, null, 2));
    });
}
