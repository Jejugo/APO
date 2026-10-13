// Entrega (M4.7/M4.9) — seção 27 do PLAN.md. O resumo vira o corpo do PR.
// O PR nunca é mergeado pelo APO.

import { execa } from "execa";
import type { CompletionVerdict, RequirementCheck, ReviewFinding } from "./completion.js";
import type { GateResult } from "./quality.js";

export interface DeliveryInput {
  objective: string;
  integrationBranch: string;
  tasks: Array<{
    seq: number;
    title: string;
    summary: string | null;
    actualChangedPaths: string[] | null;
  }>;
  gates: GateResult[];
  requirements: RequirementCheck[];
  findings: ReviewFinding[];
  verdict: CompletionVerdict;
  fixIterations: number;
  /** M7: perguntas dos workers e quem decidiu. */
  decisions?: Array<{
    question: string;
    answer: string;
    answeredBy: "human" | "lead";
    reason: string;
    rationale?: string | undefined;
  }>;
}

export function buildDeliverySummary(input: DeliveryInput): string {
  const changed = [...new Set(input.tasks.flatMap((task) => task.actualChangedPaths ?? []))].sort();
  const list = (items: string[], empty: string) => (items.length > 0 ? items.join("\n") : empty);
  const sections = [
    `## Objetivo\n\n${input.objective}`,
    `## Tasks\n\n${list(
      input.tasks.map(
        (task) => `- #${task.seq} ${task.title}${task.summary ? ` — ${task.summary}` : ""}`,
      ),
      "- (nenhuma)",
    )}`,
    `## Arquivos alterados\n\n${list(
      changed.map((path) => `- \`${path}\``),
      "- (nenhum registrado)",
    )}`,
    `## Quality gates\n\n${list(
      input.gates.map(
        (gate) => `- ${gate.gate}: ${gate.status}${gate.command ? ` (\`${gate.command}\`)` : ""}`,
      ),
      "- (nenhum)",
    )}`,
    `## Requisitos\n\n${list(
      input.requirements.map((check) => `- [${check.satisfied ? "x" : " "}] ${check.requirement}`),
      "- (nenhum)",
    )}`,
    `## Review\n\n${list(
      input.findings.map(
        (finding) =>
          `- **${finding.severity}**${finding.file ? ` \`${finding.file}\`` : ""}: ${finding.description}`,
      ),
      "- Nenhum finding.",
    )}`,
    ...((input.decisions ?? []).length > 0
      ? [
          `## Decisões tomadas\n\n${(input.decisions ?? [])
            .map((decision) => {
              const who =
                decision.answeredBy === "human"
                  ? "você"
                  : decision.reason === "delegated"
                    ? "Lead (delegado por você)"
                    : decision.reason === "timeout"
                      ? "Lead (prazo de resposta vencido)"
                      : "Lead (você ausente)";
              return `- **${decision.question}** → ${decision.answer} _(${who}${decision.rationale ? `: ${decision.rationale}` : ""})_`;
            })
            .join("\n")}`,
        ]
      : []),
    `Rodadas de correção: ${input.fixIterations}. Branch: \`${input.integrationBranch}\`.`,
    "_Gerado pelo APO. O merge é manual._",
  ];
  return sections.join("\n\n");
}

export interface PullRequestInput {
  repoPath: string;
  integrationPath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface PullRequestCreator {
  create(input: PullRequestInput): Promise<{ url: string }>;
}

/**
 * `git push` da branch de integração, sem abrir PR (fase de teste: o usuário
 * quer ver a branch no GitHub antes de aprovar). Idempotente: repetir só envia
 * o que mudou. Devolve o commit publicado.
 */
export async function pushBranch(
  integrationPath: string,
  branch: string,
): Promise<{ commit: string }> {
  await execa("git", ["push", "--set-upstream", "origin", branch], { cwd: integrationPath });
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd: integrationPath });
  return { commit: head.stdout.trim() };
}

/** `https://github.com/<dono>/<repo>/tree/<branch>` a partir do remoto `origin` (sem credenciais). */
export async function branchWebUrl(
  integrationPath: string,
  branch: string,
): Promise<string | undefined> {
  const remote = await execa("git", ["remote", "get-url", "origin"], {
    cwd: integrationPath,
    reject: false,
  });
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote.stdout.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}/tree/${branch}` : undefined;
}

/** `git push` da branch de integração + `gh pr create`. Nunca faz merge. */
export class GhPullRequestCreator implements PullRequestCreator {
  async create(input: PullRequestInput): Promise<{ url: string }> {
    await pushBranch(input.integrationPath, input.branch);
    const existing = await execa(
      "gh",
      [
        "pr",
        "list",
        "--head",
        input.branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url",
      ],
      { cwd: input.repoPath, reject: false },
    );
    if (existing.exitCode === 0 && existing.stdout.trim()) {
      return { url: existing.stdout.trim() };
    }
    const created = await execa(
      "gh",
      [
        "pr",
        "create",
        "--base",
        input.base,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      { cwd: input.repoPath },
    );
    const url = created.stdout.trim().split("\n").pop() ?? "";
    return { url };
  }
}
