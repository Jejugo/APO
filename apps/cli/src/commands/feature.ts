import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";
import { watchFeature } from "../live/watch.js";
import { summarizeObjective } from "../objective-summary.js";
import { resolveProjectRef } from "../project-ref.js";

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
    .description("Lista Features de um Project (uma linha cada: id, status e resumo do objetivo)")
    .requiredOption("--project <id|nome>", "id ou nome do Project (veja 'apo project list')")
    .option("--full", "mostra o objetivo inteiro, em vez do resumo de uma linha")
    .action(async (options: { project: string; full?: boolean }) => {
      const rows = await daemonRequest<FeatureRow[]>(
        `/features?projectId=${encodeURIComponent(await resolveProjectRef(options.project))}`,
      );
      if (rows.length === 0) {
        console.log("Nenhuma feature encontrada.");
        return;
      }
      for (const row of rows) {
        console.log(
          `${row.id}  [${row.status}]  ${options.full ? row.objective : summarizeObjective(row.objective)}`,
        );
      }
    });

  feature
    .command("watch <id>")
    .description(
      "Painel ao vivo da Feature: Tasks, agentes e eventos (número + Enter abre o agente ao vivo)",
    )
    .action(async (id: string) => {
      await watchFeature(id);
    });

  feature
    .command("questions <id> <modo>")
    .description("Modo das perguntas só desta Feature: ask_human | lead_first | auto | default")
    .action(async (id: string, mode: string) => {
      if (!["ask_human", "lead_first", "auto", "default"].includes(mode)) {
        console.error("Use: ask_human, lead_first, auto ou default.");
        process.exitCode = 1;
        return;
      }
      await daemonRequest(`/features/${id}/questions`, {
        method: "POST",
        body: { mode: mode === "default" ? null : mode },
      });
      console.log(
        `Perguntas desta Feature: ${mode === "default" ? "modo herdado (global/projeto)" : mode}.`,
      );
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
      const decisions = (
        await daemonRequest<
          Array<{
            question: string;
            status: string;
            resolution: {
              answer: string;
              answeredBy: string;
              reason: string;
              rationale?: string;
            } | null;
          }>
        >(`/features/${id}/questions`)
      ).filter((question) => question.resolution || question.status === "pending");
      if (decisions.length > 0) {
        console.log("\nPerguntas dos workers:");
        for (const decision of decisions) {
          if (!decision.resolution) {
            console.log(`  ❓ ${decision.question}  (esperando resposta: apo questions list)`);
            continue;
          }
          const who =
            decision.resolution.answeredBy === "human"
              ? "você"
              : decision.resolution.reason === "delegated"
                ? "Lead, delegado por você"
                : decision.resolution.reason === "timeout"
                  ? "Lead, prazo vencido"
                  : "Lead, você ausente";
          console.log(
            `  • ${decision.question}\n    → ${decision.resolution.answer} (${who}${decision.resolution.rationale ? `: ${decision.resolution.rationale}` : ""})`,
          );
        }
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
