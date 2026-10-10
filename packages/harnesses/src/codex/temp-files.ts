// Arquivos temporários exigidos pela CLI do Codex (--output-schema lê de um
// arquivo, -o escreve em um arquivo) — nunca dentro do cwd da Task, para não
// poluir a worktree (mesmo princípio do $APO_RESULT_PATH, TECHNICAL_PLAN.md
// seção 6.3).

import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonSchema } from "../types.js";

export interface CodexTempFiles {
  outputLastMessagePath: string;
  outputSchemaPath?: string;
  cleanup(): Promise<void>;
}

export async function prepareCodexTempFiles(
  outputSchema: JsonSchema | undefined,
): Promise<CodexTempFiles> {
  const runId = randomUUID();
  const outputLastMessagePath = join(tmpdir(), `apo-codex-${runId}-output.txt`);
  const paths = [outputLastMessagePath];

  let outputSchemaPath: string | undefined;
  if (outputSchema) {
    outputSchemaPath = join(tmpdir(), `apo-codex-${runId}-schema.json`);
    await writeFile(
      outputSchemaPath,
      JSON.stringify(normalizeForCodexStrictMode(outputSchema)),
      "utf8",
    );
    paths.push(outputSchemaPath);
  }

  return {
    outputLastMessagePath,
    ...(outputSchemaPath !== undefined ? { outputSchemaPath } : {}),
    async cleanup() {
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    },
  };
}

// Achado real (não previsto no spike M0.10): `--output-schema` do Codex usa o
// modo "strict" da OpenAI — um schema de objeto sem `additionalProperties:
// false` falha com 400 ("'schema.additionalProperties' is required to be
// supplied and to be false when strict is true"), mesmo sendo um JSON Schema
// válido. O Claude Code aceita o mesmo schema sem essa exigência. Para que
// quem chama `AgentHarness.execute()` escreva um único `outputSchema` e ele
// funcione nos dois harnesses, o adapter do Codex normaliza isso aqui — só no
// nível raiz, que é o caso real de uso (resposta estruturada de um turno).
function normalizeForCodexStrictMode(schema: JsonSchema): JsonSchema {
  if (schema.type === "object" && !("additionalProperties" in schema)) {
    return { ...schema, additionalProperties: false };
  }
  return schema;
}

export async function readLastMessage(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}
