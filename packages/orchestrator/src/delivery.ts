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

/** `git push` da branch de integração + `gh pr create`. Nunca faz merge. */
export class GhPullRequestCreator implements PullRequestCreator {
  async create(input: PullRequestInput): Promise<{ url: string }> {
    await execa("git", ["push", "--set-upstream", "origin", input.branch], {
      cwd: input.integrationPath,
    });
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
