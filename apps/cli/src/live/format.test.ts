import { describe, expect, it } from "vitest";
import { formatAgentLine, stripAnsi } from "./format.js";

const f = (event: unknown) => formatAgentLine(JSON.stringify(event));

describe("formatAgentLine", () => {
  it("Claude Code (stream-json): ferramentas, texto, erros e fim", () => {
    expect(f({ type: "system", subtype: "init", model: "claude-opus-5-5" })[0]).toContain(
      "Claude Code iniciada",
    );
    expect(f({ type: "system", subtype: "hook_started" })).toEqual([]);
    const assistant = f({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Vou criar o arquivo." },
          { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
          { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
          { type: "tool_use", name: "Read", input: { file_path: "src/b.ts" } },
        ],
      },
    });
    expect(assistant).toEqual([
      "💬 Vou criar o arquivo.",
      "$ pnpm test",
      "✎ src/a.ts",
      "📖 src/b.ts",
    ]);
    expect(
      f({
        type: "user",
        message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
      }),
    ).toEqual(["  ✗ boom"]);
    expect(
      f({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    ).toEqual([]);
    expect(
      f({
        type: "result",
        is_error: false,
        num_turns: 4,
        duration_ms: 12_000,
        total_cost_usd: 0.0421,
      })[0],
    ).toBe("■ concluído (4 turnos · 12s · US$ 0.042)");
  });

  it("Codex (--json): comando, arquivo alterado, mensagem, falha", () => {
    expect(
      f({ type: "item.started", item: { type: "command_execution", command: "go test ./..." } }),
    ).toEqual(["$ go test ./..."]);
    expect(
      f({
        type: "item.completed",
        item: { type: "file_change", changes: [{ path: "a.go", kind: "update" }] },
      }),
    ).toEqual(["✎ a.go (update)"]);
    expect(f({ type: "item.completed", item: { type: "agent_message", text: "Pronto." } })).toEqual(
      ["💬 Pronto."],
    );
    expect(
      f({
        type: "item.completed",
        item: { type: "command_execution", exit_code: 1, aggregated_output: "FAIL" },
      }),
    ).toEqual(["  ✗ exit 1: FAIL"]);
    expect(f({ type: "turn.failed", error: { message: "usage limit" } })[0]).toContain(
      "usage limit",
    );
  });

  it("stripAnsi tira os códigos de cor", () => {
    const esc = String.fromCharCode(27);
    expect(stripAnsi(`${esc}[2m21:57${esc}[0m evento`)).toBe("21:57 evento");
  });

  it("caminhos do APO ficam curtos", () => {
    const edit = f({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/home/apo/.apo/worktrees/f1/t1/src/a.ts" },
          },
        ],
      },
    });
    expect(edit).toEqual(["✎ src/a.ts (novo/reescrito)"]);
    const report = f({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/home/apo/.apo/runs/a1/result.json" },
          },
        ],
      },
    });
    expect(report[0]).toContain("relatório da Task");
  });

  it("linhas de controle, stderr, lixo e agy", () => {
    expect(formatAgentLine("# 2026-10-11T00:00:00Z claude (cwd: /x) início")).toEqual([
      "— processo iniciado —",
    ]);
    expect(formatAgentLine("# fim 2026-10-11T00:00:01Z exit=0")).toEqual([
      "— processo terminou (exit 0) —",
    ]);
    expect(formatAgentLine("[stderr] aviso")).toEqual(["stderr: aviso"]);
    expect(formatAgentLine('{"type": quebrado')).toEqual([]);
    expect(f({ status: "SUCCESS", response: "feito", conversation_id: "x" })).toEqual([
      "💬 feito",
      "■ concluído",
    ]);
  });
});
