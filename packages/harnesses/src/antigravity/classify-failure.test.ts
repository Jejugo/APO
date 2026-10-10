import { describe, expect, it } from "vitest";
import { buildAntigravityArgs } from "./build-args.js";
import { classifyAntigravityFailure, parseAntigravityJson } from "./classify-failure.js";

// Saídas reais do spike M2.23 (spikes/antigravity.md).
const SUCCESS =
  '{"conversation_id":"2d7d7660-e9a8-40ba-b22f-3956c4815e97","status":"SUCCESS","response":"ok\\n","duration_seconds":1.99,"num_turns":1}';
const INVALID_MODEL =
  '{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \\"x\\" --effort \\"\\"): model x is not recognized","duration_seconds":0,"num_turns":0}';

describe("AntigravityHarness — parsing", () => {
  it("lê o JSON final mesmo com avisos antes", () => {
    expect(parseAntigravityJson(`aviso qualquer\n${SUCCESS}\n`)?.status).toBe("SUCCESS");
    expect(parseAntigravityJson("sem json")).toBeUndefined();
  });

  it("status ERROR vira crash com a mensagem do campo error", () => {
    const failure = classifyAntigravityFailure(parseAntigravityJson(INVALID_MODEL), "", 1);
    expect(failure.kind).toBe("crash");
    expect(failure.message).toContain("invalid model selection");
  });

  it("erro com texto de limite vira rate_limited", () => {
    const failure = classifyAntigravityFailure(
      { status: "ERROR", error: "You've hit your usage limit. Try again in 30 minutes." },
      "",
      1,
    );
    expect(["rate_limited", "quota_exhausted"]).toContain(failure.kind);
  });

  it("args: modo por mode, --add-dir por diretório, --conversation no resume", () => {
    const base = { prompt: "p", cwd: "/r", networkAccess: false, timeoutMs: 1, logPath: "/l" };
    expect(buildAntigravityArgs({ ...base, mode: "read-only" })).toContain("plan");
    const args = buildAntigravityArgs(
      {
        ...base,
        mode: "workspace-write",
        extraWritableDirs: ["/a", "/b"],
        model: "gemini-3.1-pro-high",
      },
      "conv-1",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "accept-edits",
        "--model",
        "gemini-3.1-pro-high",
        "--conversation",
        "conv-1",
      ]),
    );
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
  });

  it("dangerouslySkipPermissions: só com a opção ligada e nunca em read-only", () => {
    const base = { prompt: "p", cwd: "/r", networkAccess: false, timeoutMs: 1, logPath: "/l" };
    const flag = "--dangerously-skip-permissions";
    expect(buildAntigravityArgs({ ...base, mode: "workspace-write" })).not.toContain(flag);
    expect(
      buildAntigravityArgs({ ...base, mode: "workspace-write" }, undefined, {
        dangerouslySkipPermissions: true,
      }),
    ).toContain(flag);
    expect(
      buildAntigravityArgs({ ...base, mode: "read-only" }, undefined, {
        dangerouslySkipPermissions: true,
      }),
    ).not.toContain(flag);
  });
});
