import { describe, expect, it } from "vitest";
import { gatesOf } from "./live.js";

const at = (second: number) => `2026-10-13T20:00:${String(second).padStart(2, "0")}.000Z`;
const started = (gate: string, iteration: number, second: number) => ({
  type: "quality.gate_started",
  payload: { iteration, gate, command: `pnpm ${gate}` },
  createdAt: at(second),
});
const finished = (gate: string, iteration: number, status: string, second: number) => ({
  type: "quality.gate_finished",
  payload: { iteration, gate, status, durationMs: 4000 },
  createdAt: at(second),
});

describe("gatesOf", () => {
  it("etapa sem fim está running; as encerradas trazem status e duração", () => {
    const gates = gatesOf(
      [started("build", 0, 1), finished("build", 0, "passed", 5), started("lint", 0, 6)],
      0,
    );
    expect(gates).toEqual([
      {
        gate: "build",
        command: "pnpm build",
        status: "passed",
        startedAt: "2026-10-13T20:00:01.000Z",
        durationMs: 4000,
      },
      {
        gate: "lint",
        command: "pnpm lint",
        status: "running",
        startedAt: "2026-10-13T20:00:06.000Z",
      },
    ]);
  });

  it("só conta a iteração atual e ignora outros eventos", () => {
    const gates = gatesOf(
      [
        started("build", 0, 1),
        finished("build", 0, "failed", 3),
        { type: "wave.started", payload: {}, createdAt: at(4) },
        started("build", 1, 9),
      ],
      1,
    );
    expect(gates.map((gate) => `${gate.gate}:${gate.status}`)).toEqual(["build:running"]);
  });
});
