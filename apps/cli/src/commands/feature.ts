import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface FeatureRow {
  id: string;
  projectId: string;
  objective: string;
  intent: string;
  status: string;
}

interface QualityReport {
  status: string;
  fixIteration: number;
  prUrl: string | null;
  deliverySummary: string | null;
  results: Array<{
    iteration: number;
    gate: string;
    status: string;
    details: {
      findings?: Array<{ severity: string; file?: string; description: string }> | null;
      checks?: Array<{ requirement: string; satisfied: boolean }> | null;
    } | null;
  }>;
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
    .command("report <id>")
    .description("Quality gates, requisitos, review e resumo de entrega (M4)")
    .action(async (id: string) => {
      const report = await daemonRequest<QualityReport>(`/features/${id}/quality`);
      console.log(`Status: ${report.status}  |  rodadas de correção: ${report.fixIteration}`);
      if (report.prUrl) console.log(`PR: ${report.prUrl}`);
      const iterations = [...new Set(report.results.map((row) => row.iteration))];
      for (const iteration of iterations) {
        console.log(`\nIteração ${iteration}:`);
        for (const row of report.results.filter((candidate) => candidate.iteration === iteration)) {
          const detail =
            row.gate === "review"
              ? ` — ${(row.details?.findings ?? []).length} finding(s)`
              : row.gate === "requirements"
                ? ` — ${(row.details?.checks ?? []).filter((check) => check.satisfied).length}/${(row.details?.checks ?? []).length} atendidos`
                : "";
          console.log(`  ${row.gate.padEnd(13)} ${row.status}${detail}`);
          for (const finding of row.details?.findings ?? []) {
            console.log(
              `      [${finding.severity}] ${finding.file ? `${finding.file}: ` : ""}${finding.description}`,
            );
          }
        }
      }
      if (report.status === "awaiting_approval") {
        console.log(
          `\nFeature pronta. Abrir o Pull Request?  apo approve ${id}  |  apo reject ${id} --reason "..."`,
        );
      }
      if (report.deliverySummary) console.log(`\n${report.deliverySummary}`);
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
