import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";
import { c, formatAgentLine } from "../live/format.js";
import { followTask } from "../live/tail.js";

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
            `  ${decision.createdAt} [${decision.router}] ${decision.resolutionSource} → ${target}: ${decision.output?.reason ?? ""}`,
          );
          const semantic = decision.output?.semantic;
          if (semantic) {
            const ranking = semantic.ranking
              .map((entry) => `${entry.targetId}=${entry.probability.toFixed(2)}`)
              .join(", ");
            console.log(
              `      Jev: complexidade ${semantic.complexity}, risco ${semantic.risk}, review ${semantic.requiresReview.toFixed(2)}, confiança ${semantic.confidence.toFixed(2)} — ${ranking}`,
            );
            if (decision.output?.overriddenByPolicy) {
              console.log(
                `      política de capacidade trocou a sugestão (${decision.output.suggested}) por ${target}`,
              );
            }
          }
          if (decision.output?.semanticError) {
            console.log(
              `      Jev falhou (RuleBasedRouter assumiu): ${decision.output.semanticError}`,
            );
          }
          for (const considered of decision.output?.considered ?? []) {
            console.log(
              `      candidato ${considered.targetId}: ${considered.availability}${considered.eliminated ? ` (eliminado: ${considered.eliminated})` : ""}`,
            );
          }
        }
      }
    });

  task
    .command("answer <id> [resposta...]")
    .description(
      "Responde a pergunta do worker: a opção (ex.: b) ou texto livre; --delegate deixa o Lead decidir",
    )
    .option("--delegate", "decida você: o Lead do APO escolhe e registra o motivo")
    .action(async (id: string, words: string[], options: { delegate?: boolean }) => {
      const answer = words.join(" ").trim();
      if (!options.delegate && !answer) {
        console.error("Informe a resposta (ex.: apo task answer <task> b) ou use --delegate.");
        process.exitCode = 1;
        return;
      }
      const result = await daemonRequest<{ answeredBy: string; answer: string }>(
        `/tasks/${id}/answer`,
        {
          method: "POST",
          body: options.delegate ? { delegate: true } : { answer },
        },
      );
      console.log(
        result.answeredBy === "lead"
          ? `O Lead decidiu: ${result.answer.replace(/\.+$/, "")}. O worker retoma com essa decisão.`
          : `Resposta registrada: ${result.answer.replace(/\.+$/, "")}. O worker retoma a partir dela.`,
      );
    });

  task
    .command("tail <id>")
    .description(
      "O que o agente da Task está fazendo (comandos, arquivos, mensagens); -f acompanha ao vivo",
    )
    .option("-f, --follow", "acompanha até a Task terminar (troca de attempt sozinho em failover)")
    .option("--raw", "linhas cruas do log, sem formatar")
    .action(async (id: string, options: { follow?: boolean; raw?: boolean }) => {
      const show = (line: string) => {
        if (options.raw) console.log(line);
        else for (const out of formatAgentLine(line)) console.log(out);
      };
      if (!options.follow) {
        const data = await daemonRequest<{
          attempt: { n: number; target: string | null; status: string } | null;
          lines: string[];
        }>(`/tasks/${id}/live`);
        if (!data.attempt) {
          console.log("A Task ainda não começou.");
          return;
        }
        console.log(
          c.bold(
            `── attempt #${data.attempt.n} em ${data.attempt.target ?? "?"} (${data.attempt.status}) ──`,
          ),
        );
        for (const line of data.lines) show(line);
        return;
      }
      const follow = await followTask(id, {
        onAttempt: (attempt) =>
          console.log(
            c.bold(`\n── attempt #${attempt.n} em ${attempt.target ?? "?"} (${attempt.status}) ──`),
          ),
        onLine: show,
        onDone: (status) => console.log(c.bold(`\n── Task ${status} ──`)),
      });
      process.once("SIGINT", () => follow.stop());
      await follow.finished;
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
  router: string;
  resolutionSource: string;
  finalTarget: { targetId: string } | null;
  output: {
    reason?: string;
    considered?: Array<{ targetId: string; availability: string; eliminated?: string }>;
    semantic?: {
      complexity: string;
      risk: string;
      requiresReview: number;
      confidence: number;
      ranking: Array<{ targetId: string; probability: number }>;
    };
    semanticError?: string;
    overriddenByPolicy?: boolean;
    suggested?: string;
  } | null;
}
