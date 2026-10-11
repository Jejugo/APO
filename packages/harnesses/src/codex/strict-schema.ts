// Modo "strict" da OpenAI no `--output-schema` do Codex. Achados reais:
// - M1.4: objeto sem `additionalProperties: false` → 400;
// - M4 (E2E real do review): todo campo precisa estar em `required` → 400
//   ("'required' is required to include every key in properties. Missing 'file'").
//
// Para quem chama `AgentHarness.execute()` escrever um único schema (com campos
// opcionais) que funcione nos dois harnesses, o adapter do Codex:
// 1. normaliza o schema, recursivamente: `additionalProperties: false`, todo
//    campo em `required`, e campo que era opcional passa a aceitar `null`;
// 2. remove da resposta os `null` que ele mesmo introduziu, para o resultado
//    voltar ao formato do schema original (campo opcional ausente).

import type { JsonSchema } from "../types.js";

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function nullable(schema: Schema): Schema {
  const type = schema.type;
  if (typeof type === "string") return { ...schema, type: [type, "null"] };
  if (Array.isArray(type))
    return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

export function normalizeForCodexStrictMode(schema: JsonSchema): JsonSchema {
  return normalize(schema as Schema) as JsonSchema;
}

function normalize(schema: Schema): Schema {
  const result: Schema = { ...schema };
  const properties = asSchema(schema.properties);
  if (schema.type === "object" || properties) {
    if (!("additionalProperties" in schema)) result.additionalProperties = false;
    if (properties) {
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const normalized: Schema = {};
      for (const [key, value] of Object.entries(properties)) {
        const child = normalize(asSchema(value) ?? {});
        normalized[key] = required.has(key) ? child : nullable(child);
      }
      result.properties = normalized;
      result.required = Object.keys(properties);
    }
  }
  const items = asSchema(schema.items);
  if (items) result.items = normalize(items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      result[key] = (schema[key] as unknown[]).map((entry) => normalize(asSchema(entry) ?? {}));
    }
  }
  return result;
}

/** Desfaz o passo 2: tira `null` de campos que eram opcionais no schema original. */
export function stripIntroducedNulls(value: unknown, schema: JsonSchema | undefined): unknown {
  const original = asSchema(schema);
  if (!original) return value;
  if (Array.isArray(value)) {
    const items = asSchema(original.items);
    return items ? value.map((entry) => stripIntroducedNulls(entry, items as JsonSchema)) : value;
  }
  const properties = asSchema(original.properties);
  if (!properties || !value || typeof value !== "object") return value;
  const required = new Set(Array.isArray(original.required) ? (original.required as string[]) : []);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null && !required.has(key)) continue;
    output[key] = stripIntroducedNulls(entry, asSchema(properties[key]) as JsonSchema | undefined);
  }
  return output;
}
