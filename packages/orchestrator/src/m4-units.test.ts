// Unidades do M4: completion contract (função pura) e QualityGateRunner.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CompletionInput, evaluateCompletion } from "./completion.js";
import { runQualityGates } from "./quality.js";

const READY: CompletionInput = {
  gates: { build: "passed", lint: "passed", typecheck: "skipped", tests: "passed" },
  requirements: [{ requirement: "lista produtos", satisfied: true }],
  findings: [{ severity: "low", description: "nome" }],
  blockingSeverity: "medium",
};

describe("completion contract (M4.4)", () => {
  it("tudo atendido → ready (gate skipped e finding abaixo do limite não bloqueiam)", () => {
    expect(evaluateCompletion(READY)).toMatchObject({ ready: true, reasons: [] });
  });

  it.each<[string, Partial<CompletionInput>]>([
    ["build falhou", { gates: { ...READY.gates, build: "failed" } }],
    ["lint falhou", { gates: { ...READY.gates, lint: "failed" } }],
    ["typecheck falhou", { gates: { ...READY.gates, typecheck: "failed" } }],
    ["tests não rodou", { gates: { build: "passed", lint: "passed", typecheck: "passed" } }],
    ["requisito faltando", { requirements: [{ requirement: "x", satisfied: false }] }],
    ["requisitos não verificados", { requirements: undefined }],
    ["requisitos vazios", { requirements: [] }],
    ["review não rodou", { findings: undefined }],
    [
      "finding medium com limite medium",
      { findings: [{ severity: "medium", description: "bug" }] },
    ],
    ["finding critical", { findings: [{ severity: "critical", description: "injeção de SQL" }] }],
  ])("%s → não ready", (_name, change) => {
    const verdict = evaluateCompletion({ ...READY, ...change });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("blockingSeverity alto deixa passar findings menores", () => {
    const verdict = evaluateCompletion({
      ...READY,
      findings: [{ severity: "medium", description: "x" }],
      blockingSeverity: "high",
    });
    expect(verdict.ready).toBe(true);
  });
});

describe("QualityGateRunner (M4.1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoWith(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "apo-quality-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".apo"));
    writeFileSync(join(dir, ".apo", "project.yaml"), yaml);
    return dir;
  }

  it("ordem fixa, skipped sem comando, para no primeiro que falha", async () => {
    const dir = repoWith(
      "quality:\n  commands:\n    build: echo build-ok\n    typecheck: echo 'erro TS2322' && exit 2\n    tests: echo nunca\n",
    );
    const results = await runQualityGates(dir, dir);
    expect(results.map((result) => `${result.gate}:${result.status}`)).toEqual([
      "build:passed",
      "lint:skipped",
      "typecheck:failed",
    ]);
    expect(results[2]?.output).toContain("erro TS2322");
  });

  it("prepare falhando para tudo antes dos gates", async () => {
    const dir = repoWith(
      "workspace:\n  prepare: exit 1\nquality:\n  commands:\n    tests: 'true'\n",
    );
    const results = await runQualityGates(dir, dir);
    expect(results.map((result) => `${result.gate}:${result.status}`)).toEqual(["prepare:failed"]);
  });

  it("sem nenhum comando: tudo skipped, sem rodar prepare", async () => {
    const dir = repoWith("workspace:\n  prepare: exit 1\n");
    const results = await runQualityGates(dir, dir);
    expect(results.every((result) => result.status === "skipped")).toBe(true);
  });
});

describe("resumo de entrega (M4.7)", () => {
  it("listas contínuas em markdown, seções separadas", async () => {
    const { buildDeliverySummary } = await import("./delivery.js");
    const summary = buildDeliverySummary({
      objective: "obj",
      integrationBranch: "apo/f1/integration",
      tasks: [
        { seq: 1, title: "a", summary: "feito", actualChangedPaths: ["src/a.ts"] },
        { seq: 2, title: "b", summary: null, actualChangedPaths: ["src/a.ts", "src/b.ts"] },
      ],
      gates: [
        { gate: "build", status: "passed", command: "pnpm build", durationMs: 1 },
        { gate: "lint", status: "skipped", durationMs: 0 },
      ],
      requirements: [{ requirement: "r1", satisfied: true }],
      findings: [],
      verdict: {
        ready: true,
        reasons: [],
        failedGates: [],
        missingRequirements: [],
        blockingFindings: [],
      },
      fixIterations: 0,
    });
    expect(summary).toContain(
      "## Tasks\n\n- #1 a — feito\n- #2 b\n\n## Arquivos alterados\n\n- `src/a.ts`\n- `src/b.ts`",
    );
    expect(summary).toContain("- build: passed (`pnpm build`)\n- lint: skipped");
  });
});
