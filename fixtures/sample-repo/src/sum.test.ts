import { describe, expect, it } from "vitest";
import { sum } from "./sum.js";

describe("sum", () => {
  it("soma dois números", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
