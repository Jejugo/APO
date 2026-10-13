import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
    .description(
      "Registra um repositório git como Project (com APO_URL, o caminho é o da máquina do daemon)",
    )
    .option("--branch <branch>", "branch base dos PRs (padrão: a do origin/HEAD do repo)")
    .option(
      "--name <nome>",
      "nome do Project, usado em --project <nome> (padrão: o nome da pasta do repositório; precisa ser único)",
    )
    .action(async (pathArg: string, options: { branch?: string; name?: string }) => {
      // Daemon remoto: o caminho é da VM e só o daemon consegue validá-lo.
      const repoPath = process.env.APO_URL ? pathArg : resolve(pathArg);
      if (!process.env.APO_URL && !existsSync(`${repoPath}/.git`)) {
        console.error(`${repoPath} não parece ser um repositório git (.git não encontrado).`);
        process.exitCode = 1;
        return;
      }
      const created = await daemonRequest<ProjectRow & { existing?: boolean }>("/projects", {
        method: "POST",
        body: {
          repoPath,
          ...(options.branch ? { defaultBranch: options.branch } : {}),
          ...(options.name ? { name: options.name } : {}),
        },
      });
      console.log(
        `${created.existing ? "Project já registrado" : "Project criado"}: ${created.id} (${created.name}, base ${created.defaultBranch})`,
      );
      if (created.existing && options.name && options.name !== created.name) {
        console.log(`O nome continua "${created.name}": um Project já registrado não é renomeado.`);
      }
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
