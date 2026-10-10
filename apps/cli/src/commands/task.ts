import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface TaskRow {
  id: string;
  featureId: string;
  seq: number;
  title: string;
  status: string;
  role: string | null;
  workspaceMode: string | null;
  dependencies: string[];
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
      const seqOf = new Map(rows.map((row) => [row.id, row.seq]));
      for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
        const deps =
          row.dependencies.length > 0
            ? `  ← #${row.dependencies.map((dep) => seqOf.get(dep) ?? "?").join(", #")}`
            : "";
        const role = row.role ? `  (${row.role}, ${row.workspaceMode ?? "?"})` : "";
        console.log(`#${row.seq} ${row.id}  [${row.status}]  ${row.title}${role}${deps}`);
      }
    });

  task
    .command("show <id>")
    .description("Mostra os detalhes de uma Task, com attempts e decisões de roteamento")
    .action(async (id: string) => {
      const [row, attempts, routing] = await Promise.all([
        daemonRequest<TaskRow>(`/tasks/${id}`),
        daemonRequest<AttemptRow[]>(`/tasks/${id}/attempts`),
        daemonRequest<RoutingRow[]>(`/tasks/${id}/routing`),
      ]);
      console.log(JSON.stringify(row, null, 2));
      if (attempts.length > 0) {
        console.log("\nAttempts:");
        for (const attempt of attempts) {
          const failure = attempt.failureKind ? ` — ${attempt.failureKind}` : "";
          const handover = attempt.handoverId ? " (com handover)" : "";
          console.log(
            `  #${attempt.n} ${attempt.targetId ?? attempt.harness} [${attempt.status}]${failure}${handover}`,
          );
        }
      }
      if (routing.length > 0) {
        console.log("\nDecisões de roteamento:");
        for (const decision of routing) {
          const target = decision.finalTarget?.targetId ?? "—";
          console.log(
            `  ${decision.createdAt} ${decision.resolutionSource} → ${target}: ${decision.output?.reason ?? ""}`,
          );
        }
      }
    });

  task
    .command("reroute <id>")
    .description(
      "Troca o target da Task: interrompe o attempt atual e continua no novo, com handover",
    )
    .option("--harness <harness>", "harness de destino (ex.: claude-code, codex)")
    .option("--provider <provider>", "provider de destino (anthropic | openai | google)")
    .action(async (id: string, options: { harness?: string; provider?: string }) => {
      if (!options.harness && !options.provider) {
        console.error("Informe --harness ou --provider.");
        process.exitCode = 1;
        return;
      }
      const result = await daemonRequest<{ interrupted: boolean }>(`/tasks/${id}/reroute`, {
        method: "POST",
        body: {
          ...(options.harness ? { harness: options.harness } : {}),
          ...(options.provider ? { provider: options.provider } : {}),
        },
      });
      console.log(
        result.interrupted
          ? "Attempt atual interrompido. A Task continua no novo target, com handover."
          : "A Task não estava rodando. O novo target vale para o próximo attempt.",
      );
    });
}

interface AttemptRow {
  n: number;
  targetId: string | null;
  harness: string;
  status: string;
  failureKind: string | null;
  handoverId: string | null;
}

interface RoutingRow {
  createdAt: string;
  resolutionSource: string;
  finalTarget: { targetId: string } | null;
  output: { reason?: string } | null;
}
