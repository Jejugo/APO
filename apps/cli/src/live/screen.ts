// Pintura de tela por diferença: o painel é desenhado uma vez e, a cada tick,
// só as linhas que mudaram são reescritas no lugar (cursor posicionado, linha
// limpa até o fim). Nada de limpar a tela inteira (`\x1b[2J`): isso piscava e,
// em vários terminais, empurrava cada quadro para o histórico de rolagem.

import { stripAnsi } from "./format.js";

export const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l"; // tela alternativa + esconde o cursor
export const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l"; // volta ao terminal normal

/** Linha mais larga que a tela quebraria e desalinharia as linhas seguintes. */
export function clipLine(line: string, width: number): string {
  const visible = stripAnsi(line);
  return visible.length <= width ? line : `${visible.slice(0, Math.max(0, width - 1))}…`;
}

export class ScreenPainter {
  private previous: string[] = [];

  /** Esquece o que está na tela: o próximo `paint` redesenha tudo (resize, volta do tail). */
  reset(): void {
    this.previous = [];
  }

  /** Devolve só os escapes necessários para a tela ficar igual a `lines`. */
  paint(lines: string[], width: number): string {
    const next = lines.map((line) => clipLine(line, width));
    let out = this.previous.length === 0 ? "\x1b[H\x1b[J" : "";
    next.forEach((line, row) => {
      if (this.previous[row] !== line) out += `\x1b[${row + 1};1H${line}\x1b[K`;
    });
    if (this.previous.length > next.length) out += `\x1b[${next.length + 1};1H\x1b[J`;
    this.previous = next;
    return out;
  }
}
