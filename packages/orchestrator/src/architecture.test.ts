// M1.14 — Teste de arquitetura: packages/orchestrator nunca conhece provider
// concreto (regra 4 do PLAN.md). O registry real (quais harnesses existem) é
// montado por quem sobe o daemon (apps/daemon), nunca aqui.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = import.meta.dirname;
const SELF_FILENAME = "architecture.test.ts";

const FORBIDDEN_LITERALS = ["claude-code", "codex", "gemini-cli"];
const FORBIDDEN_SYMBOLS = ["ClaudeCodeHarness", "CodexHarness", "GeminiCliHarness"];

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && entry.name !== SELF_FILENAME) {
      files.push(full);
    }
  }
  return files;
}

describe("arquitetura: packages/orchestrator não conhece providers", () => {
  const files = listTsFiles(SRC_DIR);

  it("encontrou arquivos de source para varrer", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s não contém literais de provider nem importa adapters concretos", (file) => {
    const content = readFileSync(file, "utf8");
    for (const literal of FORBIDDEN_LITERALS) {
      expect(content).not.toContain(literal);
    }
    for (const symbol of FORBIDDEN_SYMBOLS) {
      expect(content).not.toContain(symbol);
    }
  });
});

// M4.4 — gate de saída: nenhum caminho leva a `awaiting_approval` sem passar
// pelo completion contract. A única escrita desse status é a do node
// prepare_delivery, logo depois de `evaluateCompletion(...)` dar `ready`.
describe("arquitetura: awaiting_approval só via completion contract", () => {
  const repoRoot = join(SRC_DIR, "..", "..", "..");
  const sources = ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, group, entry.name, "src"))
      .filter((dir) => {
        try {
          return readdirSync(dir).length >= 0;
        } catch {
          return false;
        }
      })
      .flatMap((dir) => listTsFiles(dir))
      .filter((file) => !file.endsWith(".test.ts")),
  );
  const WRITE = /updateStatus\([^)]*["']awaiting_approval["']|status:\s*["']awaiting_approval["']/g;

  it("há uma única escrita, no feature-graph, precedida do evaluateCompletion", () => {
    const writes = sources.flatMap((file) => {
      const matches = readFileSync(file, "utf8").match(WRITE) ?? [];
      return matches.map(() => file);
    });
    expect(writes).toEqual([join(SRC_DIR, "feature-graph.ts")]);

    const graph = readFileSync(join(SRC_DIR, "feature-graph.ts"), "utf8");
    const node = graph.slice(
      graph.indexOf('.addNode("prepare_delivery"'),
      graph.indexOf('.addNode("await_approval"'),
    );
    const contractAt = node.indexOf("evaluateCompletion(");
    const notReadyAt = node.indexOf("if (!verdict.ready)");
    const writeAt = node.search(WRITE);
    expect(contractAt).toBeGreaterThan(-1);
    expect(notReadyAt).toBeGreaterThan(contractAt);
    expect(writeAt).toBeGreaterThan(notReadyAt);
  });
});
