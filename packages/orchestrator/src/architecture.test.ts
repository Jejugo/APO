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
