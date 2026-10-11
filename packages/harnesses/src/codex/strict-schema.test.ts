import { describe, expect, it } from "vitest";
import { normalizeForCodexStrictMode, stripIntroducedNulls } from "./strict-schema.js";

// Formato do ReviewSchema (M4.3) como o zod-to-json-schema gera.
const REVIEW = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "high"] },
          file: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
};

describe("schema estrito do Codex", () => {
  it("todo campo vira required; opcional aceita null; additionalProperties false em todo objeto", () => {
    const strict = normalizeForCodexStrictMode(REVIEW) as typeof REVIEW & {
      additionalProperties: boolean;
    };
    expect(strict.additionalProperties).toBe(false);
    const item = strict.properties.findings.items as unknown as {
      required: string[];
      properties: Record<string, { type: unknown }>;
    };
    expect(item.required).toEqual(["severity", "file", "description"]);
    expect(item.properties.file?.type).toEqual(["string", "null"]);
    expect(item.properties.description?.type).toBe("string");
  });

  it("a resposta volta ao formato original: null de campo opcional some", () => {
    const answer = { findings: [{ severity: "high", file: null, description: "bug" }] };
    expect(stripIntroducedNulls(answer, REVIEW)).toEqual({
      findings: [{ severity: "high", description: "bug" }],
    });
  });
});
