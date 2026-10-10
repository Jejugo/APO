// Suíte de contrato (M1.5): os mesmos cenários — sucesso, falha, timeout,
// cancelamento, saída estruturada — para os harnesses de M1.4 e o
// AntigravityHarness (M2.23).
//
// FakeHarness roda sempre (grátis, determinístico). ClaudeCodeHarness e
// CodexHarness só rodam com APO_LIVE_HARNESS_TESTS=1 (custo real de API,
// exatamente como no E2E real manual previsto no TECHNICAL_PLAN.md para o
// M1 — "a mesma Feature no sample-repo com --harness claude-code e com
// --harness codex" — não é algo que `pnpm test`/CI deva pagar a cada rodada).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityHarness } from "./antigravity/harness.js";
import { ClaudeCodeHarness } from "./claude-code/harness.js";
import { CodexHarness } from "./codex/harness.js";
import { FakeHarness } from "./fake/fake-harness.js";
import type { AgentExecutionInput, AgentHarness } from "./types.js";

const LIVE = process.env.APO_LIVE_HARNESS_TESTS === "1";

function baseInput(cwd: string, overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return {
    prompt: "adicione um comentário trivial no final de README.md",
    cwd,
    mode: "workspace-write",
    networkAccess: false,
    timeoutMs: 30_000,
    logPath: join(cwd, "log.txt"),
    ...overrides,
  };
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "apo-harness-contract-"));
  await execa("git", ["init"], { cwd });
  await execa("git", ["config", "user.email", "apo-test@example.com"], { cwd });
  await execa("git", ["config", "user.name", "apo test"], { cwd });
  await execa("git", ["commit", "--allow-empty", "-m", "base"], { cwd });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("FakeHarness — contrato", () => {
  it("sucesso: outcome success com sessionId e finalMessage", async () => {
    const harness = new FakeHarness({ script: [{ succeed: { finalMessage: "feito" } }] });
    const result = await harness.execute(baseInput(cwd), new AbortController().signal);
    expect(result.outcome).toBe("success");
    expect(result.finalMessage).toBe("feito");
    expect(result.sessionId).toBeDefined();
  });

  it("falha: outcome failure com o kind e resetAt do script", async () => {
    const harness = new FakeHarness({
      script: [{ fail: { kind: "rate_limited", resetInMs: 60_000 } }],
    });
    const result = await harness.execute(baseInput(cwd), new AbortController().signal);
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("rate_limited");
    expect(result.failure?.resetAt).toBeInstanceOf(Date);
  });

  it("timeout: delay maior que timeoutMs retorna failure kind timeout", async () => {
    const harness = new FakeHarness({ script: [{ delayMs: 500, succeed: {} }] });
    const result = await harness.execute(
      baseInput(cwd, { timeoutMs: 50 }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("timeout");
  });

  it("cancelamento: AbortSignal já abortado retorna failure kind cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = new FakeHarness({ script: [{ succeed: {} }] });
    const result = await harness.execute(baseInput(cwd), controller.signal);
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("cancelled");
  });

  it("cancelamento: abort no meio de um delay retorna failure kind cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const harness = new FakeHarness({ script: [{ delayMs: 5_000, succeed: {} }] });
    const result = await harness.execute(baseInput(cwd), controller.signal);
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("cancelled");
  });

  it("saída estruturada: structuredOutput do script passa adiante", async () => {
    const harness = new FakeHarness({
      script: [{ succeed: { structuredOutput: { answer: "42" } } }],
    });
    const result = await harness.execute(
      baseInput(cwd, { outputSchema: { type: "object" } }),
      new AbortController().signal,
    );
    expect(result.structuredOutput).toEqual({ answer: "42" });
  });

  it("escreve arquivo e comita quando o passo pede", async () => {
    const harness = new FakeHarness({
      script: [{ writeFile: { path: "a.txt", content: "x" }, commit: "feat: a" }],
    });
    const result = await harness.execute(baseInput(cwd), new AbortController().signal);
    expect(result.outcome).toBe("success");
    const log = await execa("git", ["log", "--oneline"], { cwd });
    expect(log.stdout).toContain("feat: a");
  });
});

describe.skipIf(!LIVE)("ClaudeCodeHarness — contrato (ao vivo, custo real de API)", () => {
  const harness: AgentHarness = new ClaudeCodeHarness();

  it("sucesso: tarefa trivial conclui com saída estruturada válida", async () => {
    const result = await harness.execute(
      baseInput(cwd, {
        mode: "read-only",
        prompt: 'responda só com um JSON {"answer": "ok"}',
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("success");
    expect(result.structuredOutput).toEqual({ answer: "ok" });
  }, 60_000);

  it("falha: modelo inexistente retorna failure estruturada", async () => {
    const result = await harness.execute(
      baseInput(cwd, { mode: "read-only", model: "modelo-que-nao-existe-xyz" }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
  }, 30_000);

  it("cancelamento: AbortSignal interrompe a execução real", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await harness.execute(
      baseInput(cwd, {
        mode: "read-only",
        prompt: "escreva um ensaio de 2000 palavras sobre história do café",
      }),
      controller.signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("cancelled");
  }, 30_000);
});

describe.skipIf(!LIVE)("CodexHarness — contrato (ao vivo, custo real de API)", () => {
  const harness: AgentHarness = new CodexHarness();

  it("sucesso: tarefa trivial conclui com saída estruturada válida", async () => {
    const result = await harness.execute(
      baseInput(cwd, {
        mode: "read-only",
        prompt: 'responda só com um JSON {"answer": "ok"}',
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("success");
    expect(result.structuredOutput).toEqual({ answer: "ok" });
  }, 60_000);

  it("falha: modelo inexistente retorna failure estruturada", async () => {
    const result = await harness.execute(
      baseInput(cwd, { mode: "read-only", model: "modelo-que-nao-existe-xyz" }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
  }, 30_000);

  it("cancelamento: AbortSignal interrompe a execução real", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await harness.execute(
      baseInput(cwd, {
        mode: "read-only",
        prompt: "escreva um ensaio de 2000 palavras sobre história do café",
      }),
      controller.signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("cancelled");
  }, 30_000);
});

// M2.23 — sem saída estruturada (spikes/antigravity.md): o "sucesso" do
// contrato é editar um arquivo, que é o único uso previsto (worker).
describe.skipIf(!LIVE)("AntigravityHarness — contrato (ao vivo, custo real de API)", () => {
  const harness: AgentHarness = new AntigravityHarness();

  it("sucesso: edita um arquivo no cwd e devolve sessionId", async () => {
    const result = await harness.execute(
      baseInput(cwd, {
        prompt: "crie o arquivo hello.txt contendo apenas: oi",
        timeoutMs: 120_000,
      }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("success");
    expect(result.sessionId).toBeDefined();
    const status = await execa("git", ["status", "--porcelain"], { cwd });
    expect(status.stdout).toContain("hello.txt");
  }, 150_000);

  it("saída estruturada pedida → invalid_output sem chamar o CLI", async () => {
    const result = await harness.execute(
      baseInput(cwd, { outputSchema: { type: "object" } }),
      new AbortController().signal,
    );
    expect(result.failure?.kind).toBe("invalid_output");
  });

  it("falha: modelo inexistente retorna failure estruturada", async () => {
    const result = await harness.execute(
      baseInput(cwd, { model: "modelo-que-nao-existe-xyz" }),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.message).toContain("invalid model selection");
  }, 30_000);

  it("cancelamento: AbortSignal interrompe a execução real", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const result = await harness.execute(
      baseInput(cwd, {
        prompt: "escreva um ensaio de 2000 palavras sobre história do café em ensaio.md",
      }),
      controller.signal,
    );
    expect(result.outcome).toBe("failure");
    expect(result.failure?.kind).toBe("cancelled");
  }, 30_000);
});
