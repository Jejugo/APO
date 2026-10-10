import { FakeHarness } from "@apo/harnesses";
import { describe, expect, it } from "vitest";
import { AgentRunnerImpl } from "./agent-runner.js";
import { classifyDeterministic, triageIntent } from "./intent-triage.js";

// M1 — "Testes obrigatórios": tabela com pelo menos 30 frases reais em
// português e inglês.
const CASES: Array<[string, "question" | "bugfix" | "feature"]> = [
  // português — question
  ["o que faz esse módulo?", "question"],
  ["por que esse endpoint retorna 404?", "question"],
  ["qual foi a decisão de routing da última Task?", "question"],
  ["como funciona o WorkspacePolicy?", "question"],
  ["quando a Feature X foi concluída?", "question"],
  ["onde está definida a função de parse?", "question"],
  ["quem criou essa Task?", "question"],
  ["quais harnesses estão disponíveis?", "question"],
  ["o repositório usa pnpm ou npm?", "question"],
  ["porque o teste está falhando?", "question"],
  // português — bugfix
  ["corrija o bug no endpoint de login", "bugfix"],
  ["conserte o erro de validação do formulário", "bugfix"],
  ["arrume a falha no cálculo de frete", "bugfix"],
  ["o botão de salvar está quebrado", "bugfix"],
  ["esse endpoint não funciona em produção", "bugfix"],
  ["corrigir o vazamento de memória no worker", "bugfix"],
  // português — feature
  ["crie uma tela de cadastro de usuários", "feature"],
  ["adicione suporte a dark mode", "feature"],
  ["implemente autenticação via OAuth", "feature"],
  ["construa um dashboard de métricas", "feature"],
  ["adicionar um botão de exportar CSV", "feature"],
  ["criar endpoint de busca por nome", "feature"],
  // english — question
  ["what does this module do?", "question"],
  ["why does this endpoint return 404?", "question"],
  ["how does WorkspacePolicy work?", "question"],
  ["when was feature X completed?", "question"],
  ["where is the parse function defined?", "question"],
  ["which harnesses are available?", "question"],
  // english — bugfix
  ["fix the bug in the login endpoint", "bugfix"],
  ["this endpoint is broken in production", "bugfix"],
  ["the save button doesn't work", "bugfix"],
  // english — feature
  ["create a user signup screen", "feature"],
  ["add dark mode support", "feature"],
  ["implement OAuth authentication", "feature"],
  ["build a metrics dashboard", "feature"],
];

describe("classifyDeterministic", () => {
  it.each(CASES)('classifica "%s" como %s', (input, expected) => {
    expect(classifyDeterministic(input)).toBe(expected);
  });

  it("retorna undefined para um input ambíguo", () => {
    expect(classifyDeterministic("checkout")).toBeUndefined();
  });
});

describe("triageIntent", () => {
  it("override sempre vence, sem consultar regras ou o Lead", async () => {
    const harness = new FakeHarness({ script: [] });
    const result = await triageIntent(
      "qualquer coisa",
      {
        override: "bugfix",
        agentRunner: new AgentRunnerImpl(harness),
        cwd: "/tmp",
        timeoutMs: 1_000,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ intent: "bugfix", source: "override" });
  });

  it("usa a regra determinística quando ela classifica", async () => {
    const harness = new FakeHarness({ script: [] });
    const result = await triageIntent(
      "crie uma feature nova",
      { agentRunner: new AgentRunnerImpl(harness), cwd: "/tmp", timeoutMs: 1_000 },
      new AbortController().signal,
    );
    expect(result).toEqual({ intent: "feature", source: "deterministic" });
  });

  it("cai para o Lead quando nenhuma regra determinística bate", async () => {
    const harness = new FakeHarness({
      script: [
        { succeed: { structuredOutput: { intent: "bugfix", reason: "ambíguo mas parece bug" } } },
      ],
    });
    const result = await triageIntent(
      "checkout",
      { agentRunner: new AgentRunnerImpl(harness), cwd: "/tmp", timeoutMs: 1_000 },
      new AbortController().signal,
    );
    expect(result).toEqual({ intent: "bugfix", source: "lead" });
  });

  it("lança erro quando nem a regra nem o Lead conseguem classificar", async () => {
    const harness = new FakeHarness({ script: [{ fail: { kind: "crash" } }] });
    await expect(
      triageIntent(
        "checkout",
        { agentRunner: new AgentRunnerImpl(harness), cwd: "/tmp", timeoutMs: 1_000 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/não foi possível classificar/);
  });
});
