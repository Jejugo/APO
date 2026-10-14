import { describe, expect, it } from "vitest";
import { formatTimeline, formatTotals } from "./timeline-format.js";

const totals = {
  trabalho: 0,
  tentativa_perdida: 41 * 60_000,
  gates: 0,
  review: 9 * 60_000,
  pausa_capacidade: 0,
  aguardando_voce: 35 * 60_000,
  intervalos: 13 * 60_000,
} as const;

describe("formatTotals", () => {
  it("ordena do maior para o menor e omite os zerados", () => {
    expect(formatTotals({ ...totals })).toBe(
      "tentativas perdidas 41m00s · aguardando você 35m00s · intervalos 13m00s · review 9m00s",
    );
  });
});

describe("formatTimeline", () => {
  it("etapa em andamento não tem fim nem duração fechada", () => {
    const lines = formatTimeline({
      startedAt: "2026-10-14T00:00:00.000Z",
      endedAt: "2026-10-14T01:00:00.000Z",
      totalMs: 3_600_000,
      idleMs: 0,
      totalsMs: { ...totals, trabalho: 0, intervalos: 0 },
      segments: [
        {
          kind: "gates",
          label: "gates r1 · tests",
          status: "rodando",
          startedAt: "2026-10-14T00:30:00.000Z",
          endedAt: null,
        },
      ],
    });
    expect(lines.join("\n")).toContain("em andamento");
    expect(lines.join("\n")).toContain("gates r1 · tests  [rodando]");
  });
});
