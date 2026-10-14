// Tasks corretivas a partir dos findings do review. Findings do mesmo arquivo
// viram UMA Task: cada Task é uma sessão completa de agente (~1 min de custo
// fixo) e, em série, sete findings num mesmo documento gastavam sete sessões.

import { type ReviewFinding, SEVERITIES } from "./completion.js";

export interface CorrectiveTask {
  title: string;
  description: string;
  expectedPaths: string[];
}

const TITLE_MAX = 120;

function describe(finding: ReviewFinding): string {
  return [
    `Finding do review (${finding.severity})${finding.file ? ` em ${finding.file}` : ""}: ${finding.description}`,
    finding.suggestedFix ? `Correção sugerida: ${finding.suggestedFix}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function highest(findings: ReviewFinding[]): ReviewFinding["severity"] {
  return findings.reduce(
    (top, finding) =>
      SEVERITIES.indexOf(finding.severity) > SEVERITIES.indexOf(top) ? finding.severity : top,
    findings[0]?.severity ?? "low",
  );
}

/** Um achado sem arquivo, ou sozinho no arquivo, mantém a Task individual de antes. */
export function correctivesFromFindings(findings: ReviewFinding[]): CorrectiveTask[] {
  const byFile = new Map<string, ReviewFinding[]>();
  const result: CorrectiveTask[] = [];
  const order: Array<{ file: string } | { finding: ReviewFinding }> = [];
  for (const finding of findings) {
    if (!finding.file) {
      order.push({ finding });
      continue;
    }
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else {
      byFile.set(finding.file, [finding]);
      order.push({ file: finding.file });
    }
  }
  for (const entry of order) {
    const group = "file" in entry ? (byFile.get(entry.file) ?? []) : [entry.finding];
    const [only] = group;
    if (group.length === 1 && only) {
      result.push({
        title: `Review (${only.severity}): ${only.description}`.slice(0, TITLE_MAX),
        description: describe(only),
        expectedPaths: only.file ? [only.file] : [],
      });
      continue;
    }
    const file = group[0]?.file ?? "";
    result.push({
      title: `Review (${highest(group)}): ${group.length} achados em ${file}`.slice(0, TITLE_MAX),
      description: [
        `O review apontou ${group.length} achados em ${file}. Corrija todos juntos, numa só passada, e confira no fim que um ajuste não desfez outro.`,
        ...group.map((finding, index) => `${index + 1}. ${describe(finding)}`),
      ].join("\n\n"),
      expectedPaths: [file],
    });
  }
  return result;
}
