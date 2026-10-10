import { describe, expect, it } from "vitest";
import { classifyClaudeCodeFailure } from "./classify-failure.js";

describe("classifyClaudeCodeFailure", () => {
  it("retorna undefined para uma execução bem-sucedida", () => {
    const result = classifyClaudeCodeFailure({
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      session_id: "abc-123",
      result: "feito",
      api_error_status: null,
    });
    expect(result).toBeUndefined();
  });

  // Fixture real do spike M0.9 (spikes/claude-code.md, seção 7): credencial inválida.
  it("classifica status 401 como auth", () => {
    const result = classifyClaudeCodeFailure({
      type: "result",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 401,
      result: "Invalid API key · Fix external API key",
    });
    expect(result).toEqual({ kind: "auth", message: "Invalid API key · Fix external API key" });
  });

  // Fixture real do spike M0.9: modelo inexistente.
  it("classifica status 404 (modelo inexistente) como crash", () => {
    const result = classifyClaudeCodeFailure({
      type: "result",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 404,
      result:
        "There's an issue with the selected model. It may not exist or you may not have access to it.",
    });
    expect(result?.kind).toBe("crash");
  });

  it("classifica status 429 como rate_limited", () => {
    const result = classifyClaudeCodeFailure({
      type: "result",
      is_error: true,
      api_error_status: 429,
      result: "Rate limited",
    });
    expect(result).toEqual({ kind: "rate_limited", message: "Rate limited" });
  });

  it("usa uma mensagem padrão quando result está ausente", () => {
    const result = classifyClaudeCodeFailure({
      type: "result",
      is_error: true,
      api_error_status: 500,
    });
    expect(result?.message).toBe("Erro desconhecido do Claude Code");
  });
});
