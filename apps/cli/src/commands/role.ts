import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";
import { resolveProjectRef } from "../project-ref.js";

interface RoleRow {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  executionPreference?: { mode: string; provider?: string; harness?: string; model?: string };
}

// M2.17 — roles resolvidos para um Project: embutidos + `.apo/roles/*.yaml`.
export function registerRoleCommands(program: Command): void {
  const role = program
    .command("role")
    .description("Roles dos workers (embutidos + .apo/roles do Project)");

  role
    .command("list")
    .description("Lista os roles resolvidos para o Project")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .action(async (options: { project: string }) => {
      const roles = await daemonRequest<RoleRow[]>(
        `/projects/${await resolveProjectRef(options.project)}/roles`,
      );
      for (const row of roles) {
        console.log(
          `${row.id.padEnd(22)} ${row.name}${row.description ? ` — ${row.description}` : ""}`,
        );
      }
    });

  role
    .command("show <id>")
    .description("Mostra o systemPrompt e a preferência de execução efetivos de um role")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .action(async (id: string, options: { project: string }) => {
      const roles = await daemonRequest<RoleRow[]>(
        `/projects/${await resolveProjectRef(options.project)}/roles`,
      );
      const found = roles.find((row) => row.id === id);
      if (!found) {
        console.error(
          `Role "${id}" não existe. Disponíveis: ${roles.map((row) => row.id).join(", ")}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(`${found.id} — ${found.name}`);
      if (found.description) console.log(found.description);
      const preference = found.executionPreference;
      console.log(
        `\nPreferência de execução: ${
          preference
            ? [preference.mode, preference.provider, preference.harness, preference.model]
                .filter(Boolean)
                .join(" / ")
            : "auto (router)"
        }`,
      );
      console.log(`\nsystemPrompt:\n${found.systemPrompt}`);
    });
}
