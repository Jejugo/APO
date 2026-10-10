import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProjectConfigSchema, loadConfig } from "@apo/config";
import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface ProjectRow {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  createdAt: string;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Gerencia Projects conhecidos pelo apo");

  project
    .command("add <path>")
    .description("Registra um repositório git como Project")
    .action(async (pathArg: string) => {
      const repoPath = resolve(pathArg);
      if (!existsSync(`${repoPath}/.git`)) {
        console.error(`${repoPath} não parece ser um repositório git (.git não encontrado).`);
        process.exitCode = 1;
        return;
      }

      const projectConfig = loadConfig(`${repoPath}/.apo/project.yaml`, ProjectConfigSchema);
      const name = repoPath.split("/").filter(Boolean).pop() ?? repoPath;

      const created = await daemonRequest<ProjectRow>("/projects", {
        method: "POST",
        body: { name, repoPath, configSnapshot: projectConfig },
      });
      console.log(`Project criado: ${created.id} (${created.name})`);
    });

  project
    .command("list")
    .description("Lista os Projects conhecidos")
    .action(async () => {
      const rows = await daemonRequest<ProjectRow[]>("/projects");
      if (rows.length === 0) {
        console.log("Nenhum project registrado ainda. Use 'apo project add <path>'.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  ${row.name}  ${row.repoPath}`);
      }
    });

  project
    .command("show <id>")
    .description("Mostra os detalhes de um Project")
    .action(async (id: string) => {
      const row = await daemonRequest<ProjectRow>(`/projects/${id}`);
      console.log(JSON.stringify(row, null, 2));
    });
}
