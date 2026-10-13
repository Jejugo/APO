import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";
import { resolveProjectRef } from "../project-ref.js";

interface MemoryRow {
  id: string;
  kind: string;
  source: string;
  title: string;
  content: string;
  similarity?: number;
}

const KINDS = ["convention", "decision", "pattern", "failure", "correction"];

// M5 — memória do Project (seção 22 do PLAN.md).
export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command("memory")
    .description("Memória do Project (docs indexados, convenções, decisões)");

  memory
    .command("list")
    .description("Lista as memórias do Project")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .option("--kind <kind>", "doc | convention | decision | pattern | failure | correction")
    .action(async (options: { project: string; kind?: string }) => {
      const query = options.kind ? `?kind=${encodeURIComponent(options.kind)}` : "";
      const rows = await daemonRequest<MemoryRow[]>(
        `/projects/${await resolveProjectRef(options.project)}/memories${query}`,
      );
      if (rows.length === 0) {
        console.log("Nenhuma memória.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  [${row.kind}]  ${row.title}  (${row.source})`);
      }
    });

  memory
    .command("search <texto>")
    .description("Busca semântica: o que o APO injetaria num prompt sobre esse assunto")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .action(async (text: string, options: { project: string }) => {
      const rows = await daemonRequest<MemoryRow[]>(
        `/projects/${await resolveProjectRef(options.project)}/memories?q=${encodeURIComponent(text)}`,
      );
      for (const row of rows) {
        console.log(`\n[${row.similarity?.toFixed(3)}] ${row.title}  [${row.kind}]`);
        console.log(row.content.length > 400 ? `${row.content.slice(0, 400)}…` : row.content);
      }
    });

  memory
    .command("add <conteudo>")
    .description("Registra uma memória (ex.: uma convenção que toda Task deve seguir)")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .requiredOption("--title <titulo>", "título curto")
    .option("--kind <kind>", KINDS.join(" | "), "convention")
    .action(async (content: string, options: { project: string; title: string; kind: string }) => {
      if (!KINDS.includes(options.kind)) {
        console.error(`--kind inválido. Use: ${KINDS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const result = await daemonRequest<{ inserted: number }>(
        `/projects/${await resolveProjectRef(options.project)}/memories`,
        {
          method: "POST",
          body: { kind: options.kind, title: options.title, content },
        },
      );
      console.log(result.inserted > 0 ? "Memória registrada." : "Essa memória já existia.");
    });

  memory
    .command("ingest")
    .description("Reindexa a documentação do repo (incremental: só o que mudou)")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .action(async (options: { project: string }) => {
      const report = await daemonRequest<{
        files: number;
        inserted: number;
        kept: number;
        removed: number;
      }>(`/projects/${await resolveProjectRef(options.project)}/memories/ingest`, {
        method: "POST",
      });
      console.log(
        `${report.files} arquivo(s): ${report.inserted} trecho(s) novo(s), ${report.kept} sem mudança, ${report.removed} removido(s).`,
      );
    });

  memory
    .command("remove <memoryId>")
    .description("Apaga uma memória")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .action(async (memoryId: string, options: { project: string }) => {
      await daemonRequest(
        `/projects/${await resolveProjectRef(options.project)}/memories/${memoryId}`,
        {
          method: "DELETE",
        },
      );
      console.log("Memória apagada.");
    });
}
