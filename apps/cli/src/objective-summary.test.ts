import { describe, expect, it } from "vitest";
import { summarizeObjective } from "./objective-summary.js";

describe("summarizeObjective", () => {
  it("usa só a primeira linha com texto e colapsa espaços", () => {
    expect(summarizeObjective("\n  Corrigir   o minimapa\n\nCausa raiz: …")).toBe(
      "Corrigir o minimapa",
    );
  });

  it("corta em 80 caracteres com reticências", () => {
    const resumo = summarizeObjective("a".repeat(200));
    expect(resumo).toHaveLength(80);
    expect(resumo.endsWith("…")).toBe(true);
  });

  it("texto curto fica como está; vazio vira um marcador", () => {
    expect(summarizeObjective("Crie src/slug.ts")).toBe("Crie src/slug.ts");
    expect(summarizeObjective("  \n ")).toBe("(sem objetivo)");
  });
});
