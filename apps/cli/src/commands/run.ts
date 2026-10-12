import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { DaemonHttpError, daemonRequest } from "../daemon-client.js";

interface FeatureRow {
  id: string;
  status: string;
}

interface RunOptions {
  project: string;
  harness?: string;
  prefer?: string;
  as?: "question" | "bugfix" | "feature";
  onOverlap?: "isolate" | "absorb";
  autoResolve?: boolean;
}

type RunResponse =
  | FeatureRow
  | { intent: "question"; answer: string }
  | { absorbedInto: string; taskIds: string[] };

/** 409 do FeatureOverlapCheck (M2.13). */
interface OverlapAsk {
  decision: "ask_user";
  overlappingFeatureId: string;
  overlappingObjective: string;
  sharedPaths: string[];
  intent: "bugfix" | "feature";
  plan: unknown;
}

function isOverlapAsk(body: unknown): body is OverlapAsk {
  return typeof body === "object" && body !== null && (body as OverlapAsk).decision === "ask_user";
}

async function askOverlap(ask: OverlapAsk): Promise<"isolate" | "absorb" | undefined> {
  console.log(`Este pedido se sobrepõe à Feature em andamento ${ask.overlappingFeatureId}:`);
  console.log(`  "${ask.overlappingObjective}"`);
  console.log(`  caminhos em comum: ${ask.sharedPaths.join(", ")}`);
  if (!process.stdin.isTTY) {
    console.error("Sem terminal interativo: rode de novo com --on-overlap isolate|absorb.");
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question("[i]solar numa Feature nova, [a]bsorver na existente ou [c]ancelar? ")
    )
      .trim()
      .toLowerCase();
    if (answer.startsWith("i")) return "isolate";
    if (answer.startsWith("a")) return "absorb";
    return undefined;
  } finally {
    rl.close();
  }
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <objective>")
    .description("Leva um objetivo até código commitado (ou responde direto, se for uma pergunta)")
    .requiredOption("--project <id>", "id do Project (veja 'apo project list')")
    // Pendente de confirmação (TECHNICAL_PLAN.md seção 11): resolução via cwd
    // ainda não foi decidida com o usuário — por isso --project é obrigatório
    // no M1, sem fallback silencioso.
    .option("--harness <harness>", "força um harness (forced): claude-code | codex — sem failover")
    .option("--prefer <harness>", "prefere um harness (preferred), com failover se indisponível")
    .option("--as <intent>", "força a classificação: question | bugfix | feature")
    .option(
      "--on-overlap <decision>",
      "se houver Feature ativa sobreposta: isolate | absorb (sem perguntar)",
    )
    .option("--auto-resolve", "o Lead responde as perguntas dos workers desta Feature (modo auto)")
    .action(async (objective: string, options: RunOptions) => {
      if (options.harness && options.prefer) {
        console.error("Use --harness ou --prefer, não os dois.");
        process.exitCode = 1;
        return;
      }
      const body = {
        projectId: options.project,
        objective,
        ...(options.harness !== undefined ? { harness: options.harness } : {}),
        ...(options.prefer !== undefined ? { prefer: options.prefer } : {}),
        ...(options.as !== undefined ? { as: options.as } : {}),
        ...(options.autoResolve ? { questionMode: "auto" } : {}),
      };
      let response: RunResponse;
      try {
        response = await daemonRequest<RunResponse>("/features", {
          method: "POST",
          body: options.onOverlap ? { ...body, onOverlap: options.onOverlap } : body,
        });
      } catch (error) {
        if (
          !(error instanceof DaemonHttpError) ||
          error.status !== 409 ||
          !isOverlapAsk(error.body)
        ) {
          throw error;
        }
        const ask = error.body;
        const decision = await askOverlap(ask);
        if (!decision) {
          console.log("Nada foi criado.");
          process.exitCode = 1;
          return;
        }
        // Reenvia com o plano e a classificação já feitos, para não gastar o Lead de novo.
        response = await daemonRequest<RunResponse>("/features", {
          method: "POST",
          body: {
            ...body,
            as: ask.intent,
            plan: ask.plan,
            onOverlap: decision,
            ...(decision === "absorb" ? { absorbInto: ask.overlappingFeatureId } : {}),
          },
        });
      }

      if ("absorbedInto" in response) {
        console.log(
          `Pedido absorvido pela Feature ${response.absorbedInto} (${response.taskIds.length} Task(s) nova(s)).`,
        );
        console.log(`Acompanhe com: apo logs ${response.absorbedInto} -f`);
        return;
      }

      if ("answer" in response) {
        console.log(response.answer);
        return;
      }

      console.log(`Feature criada: ${response.id} (status: ${response.status})`);
      console.log(`Acompanhe com: apo feature show ${response.id}  |  apo logs ${response.id} -f`);
    });
}
