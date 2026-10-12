import { describe, expect, it } from "vitest";
import { parseClaudeCodeStream } from "./classify-failure.js";

// Formato real do `--output-format stream-json --verbose` (capturado em 2026-10-11).
const STREAM = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.txt"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"ola"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"{\\"answer\\":\\"ola\\"}","structured_output":{"answer":"ola"},"session_id":"s1"}',
].join("\n");

describe("parseClaudeCodeStream", () => {
  it("pega o evento result final", () => {
    expect(parseClaudeCodeStream(`${STREAM}\n`)).toMatchObject({
      type: "result",
      is_error: false,
      session_id: "s1",
    });
  });

  it("sem evento result (processo morreu no meio) → undefined", () => {
    expect(parseClaudeCodeStream(STREAM.split("\n").slice(0, 3).join("\n"))).toBeUndefined();
    expect(parseClaudeCodeStream("")).toBeUndefined();
  });
});
