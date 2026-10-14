import { describe, expect, it } from "vitest";
import { correctivesFromFindings } from "./corrective.js";

describe("correctivesFromFindings", () => {
  it("achado sozinho mantém a Task individual", () => {
    expect(
      correctivesFromFindings([{ severity: "high", file: "a.md", description: "falta X" }]),
    ).toEqual([
      {
        title: "Review (high): falta X",
        description: "Finding do review (high) em a.md: falta X",
        expectedPaths: ["a.md"],
      },
    ]);
  });

  it("achados do mesmo arquivo viram uma Task só, com a maior severidade", () => {
    const tasks = correctivesFromFindings([
      { severity: "medium", file: "plano.md", description: "um", suggestedFix: "faça um" },
      { severity: "critical", file: "outro.ts", description: "dois" },
      { severity: "high", file: "plano.md", description: "três" },
    ]);
    expect(tasks.map((task) => task.title)).toEqual([
      "Review (high): 2 achados em plano.md",
      "Review (critical): dois",
    ]);
    expect(tasks[0]?.description).toContain("1. Finding do review (medium) em plano.md: um");
    expect(tasks[0]?.description).toContain("Correção sugerida: faça um");
    expect(tasks[0]?.description).toContain("2. Finding do review (high) em plano.md: três");
    expect(tasks[0]?.expectedPaths).toEqual(["plano.md"]);
  });

  it("achados sem arquivo nunca são agrupados", () => {
    const tasks = correctivesFromFindings([
      { severity: "high", description: "a" },
      { severity: "high", description: "b" },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.expectedPaths).toEqual([]);
  });
});
