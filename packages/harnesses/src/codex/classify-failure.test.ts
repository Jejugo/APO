import { describe, expect, it } from "vitest";
import {
  classifyCodexFailure,
  findCodexThreadId,
  findCodexTurnFailed,
  parseCodexJsonl,
} from "./classify-failure.js";

describe("parseCodexJsonl", () => {
  it("parseia múltiplas linhas JSONL, ignorando linhas vazias e inválidas", () => {
    const text = [
      '{"type":"thread.started","thread_id":"t-1"}',
      "",
      "não é json",
      '{"type":"turn.completed"}',
    ].join("\n");
    const events = parseCodexJsonl(text);
    expect(events).toEqual([
      { type: "thread.started", thread_id: "t-1" },
      { type: "turn.completed" },
    ]);
  });
});

describe("findCodexThreadId", () => {
  it("extrai o thread_id do evento thread.started", () => {
    const events = parseCodexJsonl(
      '{"type":"thread.started","thread_id":"abc-123"}\n{"type":"turn.completed"}',
    );
    expect(findCodexThreadId(events)).toBe("abc-123");
  });

  it("retorna undefined quando não há thread.started", () => {
    expect(findCodexThreadId(parseCodexJsonl('{"type":"turn.completed"}'))).toBeUndefined();
  });
});

describe("findCodexTurnFailed / classifyCodexFailure", () => {
  // Fixture real do spike M0.10 (spikes/codex.md, seção 7): modelo inexistente.
  it("classifica status 400 (modelo inexistente) como crash, parseando a mensagem aninhada", () => {
    const events = parseCodexJsonl(
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: JSON.stringify({
            type: "error",
            status: 400,
            error: {
              type: "invalid_request_error",
              message:
                "The 'modelo-que-nao-existe-xyz' model is not supported when using Codex with a ChatGPT account.",
            },
          }),
        },
      }),
    );
    const failed = findCodexTurnFailed(events);
    if (!failed) throw new Error("esperava um evento turn.failed");
    const failure = classifyCodexFailure(failed);
    expect(failure).toEqual({
      kind: "crash",
      message:
        "The 'modelo-que-nao-existe-xyz' model is not supported when using Codex with a ChatGPT account.",
    });
  });

  it("classifica status 401 aninhado como auth", () => {
    const event = {
      type: "turn.failed",
      error: { message: JSON.stringify({ status: 401, error: { message: "Unauthorized" } }) },
    };
    expect(classifyCodexFailure(event)).toEqual({ kind: "auth", message: "Unauthorized" });
  });

  it("classifica status 429 aninhado como rate_limited", () => {
    const event = {
      type: "turn.failed",
      error: { message: JSON.stringify({ status: 429, error: { message: "Too many requests" } }) },
    };
    expect(classifyCodexFailure(event)).toEqual({
      kind: "rate_limited",
      message: "Too many requests",
    });
  });

  it("usa a mensagem literal quando error.message não é um JSON aninhado", () => {
    const event = { type: "turn.failed", error: { message: "algo quebrou sem JSON" } };
    expect(classifyCodexFailure(event)).toEqual({
      kind: "crash",
      message: "algo quebrou sem JSON",
    });
  });

  it("retorna undefined quando não há turn.failed", () => {
    expect(findCodexTurnFailed(parseCodexJsonl('{"type":"turn.completed"}'))).toBeUndefined();
  });
});
