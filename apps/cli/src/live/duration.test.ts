import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration.js";

describe("formatDuration", () => {
  it("segundos, minutos e horas", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(309)).toBe("5m09s");
    expect(formatDuration(41_137)).toBe("11h25m");
    expect(formatDuration(-3)).toBe("0s");
  });
});
