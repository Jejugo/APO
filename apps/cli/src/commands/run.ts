import type { Command } from "commander";
import { daemonRequest } from "../daemon-client.js";

interface FeatureRow {
  id: string;
  status: string;
}

interface RunOptions {
  project: string;
  harness: "claude-code" | "codex" | "gemini-cli" | "fake";
  as?: "question" | "bugfix" | "feature";
}

type RunResponse = FeatureRow | { intent: "question"; answer: string };

export function registerRunCommand(program: Command): void {
  program
    .command("run <objective>")
    .description("Leva um objetivo até código commitado (ou responde direto, se for uma pergunta)")
    .requiredOption("--project <id>", "id do Project (veja 'apo project list')")
    // Pendente de confirmação (TECHNICAL_PLAN.md seção 11): resolução via cwd
    // ainda não foi decidida com o usuário — por isso --project é obrigatório
    // no M1, sem fallback silencioso.
    .requiredOption(
      "--harness <harness>",
      "claude-code | codex — seleção de harness ainda é manual no M1",
    )
    .option("--as <intent>", "força a classificação: question | bugfix | feature")
    .action(async (objective: string, options: RunOptions) => {
      const response = await daemonRequest<RunResponse>("/features", {
        method: "POST",
        body: {
          projectId: options.project,
          objective,
          harness: options.harness,
          ...(options.as !== undefined ? { as: options.as } : {}),
        },
      });

      if ("answer" in response) {
        console.log(response.answer);
        return;
      }

      console.log(`Feature criada: ${response.id} (status: ${response.status})`);
      console.log(`Acompanhe com: apo feature show ${response.id}  |  apo logs ${response.id} -f`);
    });
}
