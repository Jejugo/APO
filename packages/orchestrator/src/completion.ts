// Completion contract (M4.4) — seção 26 do PLAN.md. Função pura: é a ÚNICA
// porta para `awaiting_approval` (o node prepare_delivery só avança com
// `ready: true`). "Um worker disse done" nunca basta.

import type { QualityGate } from "./quality.js";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ReviewFinding {
  severity: Severity;
  file?: string | undefined;
  description: string;
  suggestedFix?: string | undefined;
}

export interface RequirementCheck {
  requirement: string;
  satisfied: boolean;
  evidence?: string | undefined;
}

export interface CompletionInput {
  gates: Partial<Record<QualityGate, "passed" | "failed" | "skipped">>;
  /** `undefined` = a verificação de requisitos não rodou. */
  requirements: RequirementCheck[] | undefined;
  /** `undefined` = o review não rodou. */
  findings: ReviewFinding[] | undefined;
  blockingSeverity: Severity;
}

export interface CompletionVerdict {
  ready: boolean;
  reasons: string[];
  failedGates: QualityGate[];
  missingRequirements: RequirementCheck[];
  blockingFindings: ReviewFinding[];
}

export function isBlocking(finding: ReviewFinding, threshold: Severity): boolean {
  return SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf(threshold);
}

export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const reasons: string[] = [];
  const failedGates = (["build", "lint", "typecheck", "tests"] as const).filter(
    (gate) => input.gates[gate] !== "passed" && input.gates[gate] !== "skipped",
  );
  for (const gate of failedGates) {
    reasons.push(`gate ${gate}: ${input.gates[gate] ?? "não rodou"}`);
  }

  const missingRequirements = (input.requirements ?? []).filter((check) => !check.satisfied);
  if (input.requirements === undefined) {
    reasons.push("verificação de requisitos não rodou");
  } else if (input.requirements.length === 0) {
    reasons.push("verificação de requisitos não listou nenhum requisito");
  }
  for (const check of missingRequirements) {
    reasons.push(`requisito não atendido: ${check.requirement}`);
  }

  const blockingFindings = (input.findings ?? []).filter((finding) =>
    isBlocking(finding, input.blockingSeverity),
  );
  if (input.findings === undefined) {
    reasons.push("review não rodou");
  }
  for (const finding of blockingFindings) {
    reasons.push(`finding ${finding.severity}: ${finding.description}`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
    failedGates,
    missingRequirements,
    blockingFindings,
  };
}
