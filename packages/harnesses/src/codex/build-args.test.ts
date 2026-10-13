import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "./build-args.js";

const base = {
  prompt: "p",
  cwd: "/r",
  mode: "read-only" as const,
  networkAccess: false,
  timeoutMs: 1,
  logPath: "/l",
};

describe("buildCodexArgs", () => {
  it("model e effort viram -m e -c model_reasoning_effort (o config.toml é ignorado)", () => {
    const args = buildCodexArgs(
      { ...base, model: "gpt-6.1-sol", effort: "xhigh" },
      { outputLastMessagePath: "/o" },
    );
    expect(args).toContain("--ignore-user-config");
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-6.1-sol"]);
    const effortAt = args.indexOf('model_reasoning_effort="xhigh"');
    expect(args[effortAt - 1]).toBe("-c");
  });

  it("sem effort: nenhum -c de raciocínio", () => {
    const args = buildCodexArgs({ ...base }, { outputLastMessagePath: "/o" });
    expect(args.some((arg) => arg.startsWith("model_reasoning_effort"))).toBe(false);
  });
});
