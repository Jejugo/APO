// TaskHandover (M3.7) — seção 6.4 do TECHNICAL_PLAN.md e 20 do PLAN.md.
//
// O agente que falhou nunca resume o próprio trabalho: ele está sem quota ou
// morto. No M3 só existe a camada determinística (git + falhas + última
// mensagem). A camada semântica via AgentRunner é opcional e fica para
// depois. `commandsRun`/`testsRun` ficam vazios: extrair isso do log de cada
// CLI exigiria um parser por provider, e o diff já carrega o essencial.

import { execa } from "execa";
import { commitIfDirty } from "./worktree.js";

const MAX_DIFF_CHARS = 12_000;

export interface TaskHandoverPayload {
  taskId: string;
  objective: string;
  completedWork: string[];
  changedFiles: string[];
  currentState: string;
  commandsRun: string[];
  testsRun: string[];
  failures: string[];
  recommendedNextSteps: string[];
  lastAgentMessage?: string;
  diff: string;
  diffTruncated: boolean;
  layer: "deterministic";
}

export interface BuildHandoverInput {
  taskId: string;
  objective: string;
  attemptNumber: number;
  worktreePath: string;
  defaultBranch: string;
  failures: string[];
  lastAgentMessage?: string;
}

export async function buildHandover(input: BuildHandoverInput): Promise<TaskHandoverPayload> {
  // Antes de qualquer handover, nada pode se perder (seção 6.4).
  await commitIfDirty(input.worktreePath, `apo: wip handover (attempt ${input.attemptNumber})`);

  const range = `${input.defaultBranch}..HEAD`;
  const [names, stat, diff] = await Promise.all([
    git(input.worktreePath, ["diff", "--name-only", range]),
    git(input.worktreePath, ["diff", "--stat", range]),
    git(input.worktreePath, ["diff", range]),
  ]);

  return {
    taskId: input.taskId,
    objective: input.objective,
    completedWork: [],
    changedFiles: names.split("\n").filter((line) => line.length > 0),
    currentState: stat.length > 0 ? stat : "nenhuma alteração commitada ainda",
    commandsRun: [],
    testsRun: [],
    failures: input.failures,
    recommendedNextSteps: [],
    ...(input.lastAgentMessage !== undefined ? { lastAgentMessage: input.lastAgentMessage } : {}),
    diff: diff.slice(0, MAX_DIFF_CHARS),
    diffTruncated: diff.length > MAX_DIFF_CHARS,
    layer: "deterministic",
  };
}

export function renderHandoverForPrompt(handover: TaskHandoverPayload): string {
  const lines = [
    "## Continuação de trabalho (handover)",
    "Esta Task já foi iniciada por outro agente, que parou antes de terminar.",
    "O trabalho dele já está commitado nesta branch: continue de onde ele parou,",
    "sem refazer o que já existe e sem desfazer o que estiver correto.",
    "",
    `Motivo da troca: ${handover.failures.at(-1) ?? "desconhecido"}`,
    "",
    "Arquivos já alterados:",
    ...(handover.changedFiles.length > 0
      ? handover.changedFiles.map((file) => `- ${file}`)
      : ["- nenhum"]),
  ];
  if (handover.lastAgentMessage) {
    lines.push(
      "",
      "Última mensagem do agente anterior:",
      handover.lastAgentMessage.slice(0, 2_000),
    );
  }
  if (handover.diff.length > 0) {
    lines.push(
      "",
      `Diff do trabalho até aqui${handover.diffTruncated ? " (truncado)" : ""}:`,
      "```diff",
      handover.diff,
      "```",
    );
  }
  return lines.join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, reject: false });
  return result.stdout.trim();
}
