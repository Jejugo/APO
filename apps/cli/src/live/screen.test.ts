import { describe, expect, it } from "vitest";
import { ScreenPainter, clipLine } from "./screen.js";

describe("ScreenPainter", () => {
  it("1º quadro limpa e escreve tudo; quadro igual não escreve nada", () => {
    const painter = new ScreenPainter();
    const first = painter.paint(["a", "b"], 80);
    expect(first.startsWith("\x1b[H\x1b[J")).toBe(true);
    expect(first).toContain("\x1b[1;1Ha\x1b[K");
    expect(first).toContain("\x1b[2;1Hb\x1b[K");
    expect(painter.paint(["a", "b"], 80)).toBe("");
  });

  it("só reescreve a linha que mudou (os segundos), sem limpar a tela", () => {
    const painter = new ScreenPainter();
    painter.paint(["APO 1m05s", "tarefa 1", "tarefa 2"], 80);
    const tick = painter.paint(["APO 1m06s", "tarefa 1", "tarefa 2"], 80);
    expect(tick).toBe("\x1b[1;1HAPO 1m06s\x1b[K");
    expect(tick).not.toContain("\x1b[2J");
  });

  it("quadro menor apaga as linhas que sobraram", () => {
    const painter = new ScreenPainter();
    painter.paint(["a", "b", "c"], 80);
    expect(painter.paint(["a", "b"], 80)).toBe("\x1b[3;1H\x1b[J");
  });

  it("reset força o redesenho completo", () => {
    const painter = new ScreenPainter();
    painter.paint(["a"], 80);
    painter.reset();
    expect(painter.paint(["a"], 80).startsWith("\x1b[H\x1b[J")).toBe(true);
  });

  it("linha mais larga que a tela é cortada (não quebra o alinhamento)", () => {
    expect(clipLine("x".repeat(30), 10)).toHaveLength(10);
    expect(clipLine("\x1b[1mcurta\x1b[0m", 10)).toBe("\x1b[1mcurta\x1b[0m");
  });
});
