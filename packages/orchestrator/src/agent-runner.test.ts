import { FakeHarness } from "@apo/harnesses";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentRunnerImpl } from "./agent-runner.js";

const schema = z.object({ answer: z.string() });

describe("AgentRunnerImpl", () => {
  it("passa ao harness o modelo e o esforço do target (Lead/Reviewer), e o input da chamada vence", async () => {
    const harness = new FakeHarness({
      script: [
        { succeed: { structuredOutput: { answer: "a" } } },
        { succeed: { structuredOutput: { answer: "b" } } },
      ],
    });
    const runner = new AgentRunnerImpl(harness, undefined, {
      model: "claude-opus-5-5",
      effort: "high",
    });
    const call = { prompt: "p", cwd: "/tmp", schema, timeoutMs: 5_000 };
    await runner.run("lead", call, new AbortController().signal);
    await runner.run("lead", { ...call, model: "outro" }, new AbortController().signal);
    expect(harness.receivedInputs.map((input) => [input.model, input.effort])).toEqual([
      ["claude-opus-5-5", "high"],
      ["outro", "high"],
    ]);
  });

  it("retorna outcome success com a saída validada pelo zod", async () => {
    const harness = new FakeHarness({
      script: [{ succeed: { structuredOutput: { answer: "ok" } } }],
    });
    const runner = new AgentRunnerImpl(harness);
    const result = await runner.run(
      "lead",
      { prompt: "pergunta trivial", cwd: "/tmp", schema, timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(result).toEqual({ outcome: "success", output: { answer: "ok" }, attempts: 1 });
  });

  it("tenta de novo quando a saída não bate com o schema, e sucede na segunda tentativa", async () => {
    const harness = new FakeHarness({
      script: [
        { succeed: { structuredOutput: { wrongField: 1 } } },
        { succeed: { structuredOutput: { answer: "agora sim" } } },
      ],
    });
    const runner = new AgentRunnerImpl(harness);
    const result = await runner.run(
      "lead",
      { prompt: "pergunta trivial", cwd: "/tmp", schema, timeoutMs: 5_000, maxRetries: 1 },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("success");
    expect(result.output).toEqual({ answer: "agora sim" });
    expect(result.attempts).toBe(2);
  });

  it("desiste após esgotar maxRetries e retorna failure invalid_output", async () => {
    const harness = new FakeHarness({
      script: [
        { succeed: { structuredOutput: { wrongField: 1 } } },
        { succeed: { structuredOutput: { wrongField: 2 } } },
      ],
    });
    const runner = new AgentRunnerImpl(harness);
    const result = await runner.run(
      "lead",
      { prompt: "pergunta trivial", cwd: "/tmp", schema, timeoutMs: 5_000, maxRetries: 1 },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("invalid_output");
    expect(result.attempts).toBe(2);
  });

  it("propaga falhas que não são invalid_output sem tentar de novo", async () => {
    const harness = new FakeHarness({ script: [{ fail: { kind: "rate_limited" } }] });
    const runner = new AgentRunnerImpl(harness);
    const result = await runner.run(
      "lead",
      { prompt: "pergunta trivial", cwd: "/tmp", schema, timeoutMs: 5_000, maxRetries: 3 },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("rate_limited");
    expect(result.attempts).toBe(1);
  });

  it("rejeita persona desconhecida", async () => {
    const harness = new FakeHarness({ script: [] });
    const runner = new AgentRunnerImpl(harness);
    await expect(
      runner.run(
        "desconhecido",
        { prompt: "x", cwd: "/tmp", schema, timeoutMs: 5_000 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/persona desconhecida/);
  });
});
