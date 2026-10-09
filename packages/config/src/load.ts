import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

export class ConfigValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: string[],
  ) {
    super(`Config inválida em ${path}:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Carrega e valida um arquivo YAML contra um schema zod. Arquivo ausente é
 * tratado como `{}` — os defaults do schema assumem o resto (regra 6 do
 * PLAN.md: o sistema continua funcionando com dado incompleto).
 */
export function loadConfig<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown = {};

  try {
    const content = readFileSync(path, "utf-8");
    raw = parseYaml(content) ?? {};
  } catch (error) {
    if (!(isErrnoException(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`,
    );
    throw new ConfigValidationError(path, issues);
  }
  return result.data;
}
