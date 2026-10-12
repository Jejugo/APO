import { describe, expect, it } from "vitest";
import { buildClaudeCodeArgs } from "./build-args.js";

const base = { prompt: "p", cwd: "/r", networkAccess: false, timeoutMs: 1, logPath: "/l" };

describe("buildClaudeCodeArgs", () => {
  it("worker de escrita: stream-json, acceptEdits e comandos liberados; --add-dir por último", () => {
    const args = buildClaudeCodeArgs({
      ...base,
      mode: "workspace-write",
      extraWritableDirs: ["/runs/a"],
    });
    expect(args).toEqual(expect.arrayContaining(["stream-json", "--verbose", "acceptEdits"]));
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual([
      "--allowedTools",
      "Bash",
    ]);
    expect(args.slice(-2)).toEqual(["--add-dir", "/runs/a"]);
  });

  it("read-only (Lead, Reviewer, Task read): modo plan e sem comandos", () => {
    const args = buildClaudeCodeArgs({ ...base, mode: "read-only" });
    expect(args).toContain("plan");
    expect(args).not.toContain("--allowedTools");
  });
});
