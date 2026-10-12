// M7 — perguntas dos workers: ver o que está esperando, responder, e o
// interruptor do modo `auto` ("deixa os agentes decidirem a noite toda").

import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";
import { c } from "../live/format.js";

interface QuestionRow {
  id: string;
  status: string;
  taskId: string;
  taskTitle: string;
  role: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  recommended?: string;
  context?: string;
  featureId?: string;
  featureObjective?: string;
  createdAt: string;
  resolution?: { answer: string; answeredBy: string; reason: string; rationale?: string } | null;
}

const MODES = ["ask_human", "lead_first", "auto"];

export function printQuestion(question: QuestionRow): void {
  console.log(
    `\n❓ ${c.bold(`O worker de ${question.role}`)} (Task ${question.taskId.slice(0, 8)} — ${question.taskTitle}) está perguntando:`,
  );
  console.log(`   ${question.question}`);
  for (const option of question.options) {
    const recommended = option.id === question.recommended ? c.green("  ← recomendado") : "";
    console.log(
      `   ${option.id}) ${option.label}${option.description ? c.dim(` — ${option.description}`) : ""}${recommended}`,
    );
  }
  if (question.context) console.log(c.dim(`   contexto: ${question.context}`));
  console.log(
    c.dim(
      `   responda: apo task answer ${question.taskId} <opção ou texto>   |   apo task answer ${question.taskId} --delegate  (decida você)`,
    ),
  );
}

export function registerQuestionCommands(program: Command): void {
  const questions = program
    .command("questions")
    .description("Perguntas dos workers e o modo de resposta (ask_human | lead_first | auto)");

  questions
    .command("list")
    .description("Perguntas esperando resposta, de todos os Projects")
    .action(async () => {
      const rows = await daemonRequest<QuestionRow[]>("/questions?status=pending");
      if (rows.length === 0) {
        console.log("Nenhuma pergunta esperando resposta.");
        return;
      }
      for (const row of rows) {
        console.log(c.dim(`\nFeature: ${row.featureObjective ?? row.featureId}`));
        printQuestion(row);
      }
    });

  questions
    .command("status")
    .description("Modo global atual")
    .action(async () => {
      const { global } = await daemonRequest<{ global: string | null }>("/settings/questions");
      console.log(
        global
          ? `Modo global: ${c.bold(global)}`
          : "Modo global: desligado (vale o de cada Feature/projeto; padrão ask_human).",
      );
    });

  questions
    .command("auto <onOff>")
    .description(
      "Liga/desliga o modo auto global: o Lead decide todas as perguntas (inclusive as que estão esperando)",
    )
    .action(async (onOff: string) => {
      if (onOff !== "on" && onOff !== "off") {
        console.error("Use: apo questions auto on | off");
        process.exitCode = 1;
        return;
      }
      await daemonRequest("/settings/questions", {
        method: "POST",
        body: { mode: onOff === "on" ? "auto" : null },
      });
      console.log(
        onOff === "on"
          ? "Modo auto ligado: o Lead decide as perguntas e registra o motivo. Os PRs continuam esperando sua aprovação."
          : "Modo auto desligado: as perguntas voltam a chegar para você.",
      );
    });

  questions
    .command("mode <modo>")
    .description(`Define o modo global: ${MODES.join(" | ")} | default`)
    .action(async (mode: string) => {
      if (mode !== "default" && !MODES.includes(mode)) {
        console.error(`Modo inválido. Use: ${MODES.join(", ")} ou default.`);
        process.exitCode = 1;
        return;
      }
      await daemonRequest("/settings/questions", {
        method: "POST",
        body: { mode: mode === "default" ? null : mode },
      });
      console.log(
        `Modo global: ${mode === "default" ? "desligado (vale o de cada projeto)" : mode}.`,
      );
    });
}
