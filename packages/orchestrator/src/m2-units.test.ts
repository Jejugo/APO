// Unidades puras do M2: planner, PromptBuilder, WorkspacePolicy, WorkerSlots.

import { DEFAULT_ROLES } from "@apo/config";
import { FakeHarness } from "@apo/harnesses";
import { describe, expect, it } from "vitest";
import { AgentRunnerImpl } from "./agent-runner.js";
import { checkFeatureOverlap, sharedPathsOf } from "./overlap.js";
import { type FeaturePlan, planFeature, planWaves, singleTaskPlan, validatePlan } from "./plan.js";
import { WORKER_CONTRACT, buildWorkerPrompt } from "./prompt-builder.js";
import { WorkerSlots } from "./worker-slots.js";
import { decideWorkspace } from "./workspace-policy.js";

function task(key: string, dependsOn: string[] = []): FeaturePlan["tasks"][number] {
  return {
    key,
    title: key,
    description: key,
    kind: "write",
    role: "generic",
    expectedPaths: [],
    dependsOn,
  };
}

describe("plan", () => {
  it("planWaves agrupa por nível topológico", () => {
    const waves = planWaves([task("a"), task("b"), task("c", ["a", "b"]), task("d", ["c"])]);
    expect(waves.map((wave) => wave.map((t) => t.key))).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("validatePlan rejeita key duplicada, dependência inexistente, auto-dependência e ciclo", () => {
    expect(validatePlan({ tasks: [task("a"), task("a")] }).ok).toBe(false);
    expect(validatePlan({ tasks: [task("a", ["x"])] }).ok).toBe(false);
    expect(validatePlan({ tasks: [task("a", ["a"])] }).ok).toBe(false);
    const cycle = validatePlan({ tasks: [task("a", ["b"]), task("b", ["a"])] });
    expect(cycle).toEqual({ ok: false, reason: expect.stringContaining("ciclo") });
    expect(validatePlan({ tasks: [task("a"), task("b", ["a"])] }).ok).toBe(true);
  });

  it("planFeature usa o plano do Lead quando válido", async () => {
    const plan: FeaturePlan = { tasks: [task("t1"), task("t2", ["t1"])] };
    const runner = new AgentRunnerImpl(
      new FakeHarness({ script: [{ succeed: { structuredOutput: plan } }] }),
    );
    const result = await planFeature(
      runner,
      { objective: "x", intent: "feature", roleIds: ["generic"], cwd: "/tmp", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(result).toEqual({ plan, source: "lead" });
  });

  it("planFeature cai para uma Task só quando o plano tem ciclo", async () => {
    const plan: FeaturePlan = { tasks: [task("t1", ["t2"]), task("t2", ["t1"])] };
    const runner = new AgentRunnerImpl(
      new FakeHarness({ script: [{ succeed: { structuredOutput: plan } }] }),
    );
    const result = await planFeature(
      runner,
      {
        objective: "objetivo",
        intent: "bugfix",
        roleIds: ["generic"],
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(result.source).toBe("fallback");
    expect(result.plan).toEqual(singleTaskPlan("objetivo"));
  });

  it("planFeature cai para uma Task só quando o Lead falha", async () => {
    const runner = new AgentRunnerImpl(new FakeHarness({ script: [{ fail: { kind: "crash" } }] }));
    const result = await planFeature(
      runner,
      {
        objective: "objetivo",
        intent: "feature",
        roleIds: ["generic"],
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      new AbortController().signal,
    );
    expect(result.source).toBe("fallback");
    expect(result.plan.tasks).toHaveLength(1);
  });
});

describe("buildWorkerPrompt", () => {
  const role = DEFAULT_ROLES.find((r) => r.id === "backend-developer");
  if (!role) throw new Error("role default ausente");

  it("ordem: role → contrato → Task → dependências → instruções do relatório", () => {
    const prompt = buildWorkerPrompt({
      role,
      featureObjective: "favoritos",
      task: { title: "API", description: "criar rota", kind: "write" },
      dependencies: [
        { title: "schema", summary: "tabela criada", artifacts: { table: "favorites" } },
      ],
      resultPath: "/runs/a/result.json",
    });
    const positions = [
      role.systemPrompt,
      WORKER_CONTRACT,
      "Task: API",
      "tabela criada",
      "/runs/a/result.json",
    ].map((part) => prompt.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('"table": "favorites"');
  });

  it("Task read avisa para não alterar arquivos; sem dependências não há seção de dependências", () => {
    const prompt = buildWorkerPrompt({
      role,
      featureObjective: "x",
      task: { title: "análise", description: "analisar", kind: "read" },
      dependencies: [],
    });
    expect(prompt).toContain("não altere arquivos");
    expect(prompt).not.toContain("Resultado das Tasks de que você depende");
  });
});

describe("decideWorkspace", () => {
  const base = { origin: "plan", reliableReadOnly: true, projectDefaultMode: "auto" as const };

  it("write sempre isolada; conflito sempre na integração", () => {
    expect(decideWorkspace({ ...base, kind: "write" })).toBe("isolated");
    expect(decideWorkspace({ ...base, kind: "write", origin: "conflict" })).toBe("integration");
  });

  it("read só vai para shared com read-only confiável e sem project forçando isolated", () => {
    expect(decideWorkspace({ ...base, kind: "read" })).toBe("shared");
    expect(decideWorkspace({ ...base, kind: "read", reliableReadOnly: false })).toBe("isolated");
    expect(decideWorkspace({ ...base, kind: "read", projectDefaultMode: "isolated" })).toBe(
      "isolated",
    );
  });
});

describe("WorkerSlots", () => {
  it("respeita o limite por provider sem bloquear outro provider", async () => {
    const slots = new WorkerSlots(3, 1);
    const releaseA = await slots.acquire("anthropic");
    let secondA = false;
    const pendingA = slots.acquire("anthropic").then((release) => {
      secondA = true;
      return release;
    });
    const releaseB = await slots.acquire("openai");
    await Promise.resolve();
    expect(secondA).toBe(false);

    releaseA();
    (await pendingA)();
    expect(secondA).toBe(true);
    releaseB();
  });

  it("respeita o limite global; liberar duas vezes não devolve dois slots", async () => {
    const slots = new WorkerSlots(1, 5);
    const release = await slots.acquire("anthropic");
    release();
    release();
    const first = await slots.acquire("openai");
    let second = false;
    void slots.acquire("google").then(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    first();
    await Promise.resolve();
    expect(second).toBe(true);
  });
});

describe("FeatureOverlapCheck", () => {
  const active = [
    { featureId: "f1", objective: "favoritos", expectedPaths: ["src/routes.ts", "src/favorites/"] },
  ];
  const signal = new AbortController().signal;

  it("sharedPathsOf: arquivo igual ou dentro de diretório comum", () => {
    expect(
      sharedPathsOf(
        ["./src/routes.ts", "src/favorites/list.ts", "README.md"],
        active[0]?.expectedPaths ?? [],
      ),
    ).toEqual(["src/favorites", "src/routes.ts"]);
    expect(sharedPathsOf(["src/route.ts"], ["src/routes.ts"])).toEqual([]);
  });

  it("sem interseção → isolated sem chamar o Lead", async () => {
    const harness = new FakeHarness({ script: [] });
    const result = await checkFeatureOverlap(
      {
        objective: "x",
        expectedPaths: ["docs/a.md"],
        active,
        runner: new AgentRunnerImpl(harness),
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      signal,
    );
    expect(result.decision).toBe("isolated");
    expect(harness.receivedPrompts).toHaveLength(0);
  });

  it("interseção relevante → ask_user; ruído → isolated", async () => {
    const ask = await checkFeatureOverlap(
      {
        objective: "x",
        expectedPaths: ["src/routes.ts"],
        active,
        runner: new AgentRunnerImpl(
          new FakeHarness({
            script: [{ succeed: { structuredOutput: { relevant: true, reason: "mesma rota" } } }],
          }),
        ),
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      signal,
    );
    expect(ask).toEqual({
      decision: "ask_user",
      overlappingFeatureId: "f1",
      overlappingObjective: "favoritos",
      sharedPaths: ["src/routes.ts"],
    });

    const noise = await checkFeatureOverlap(
      {
        objective: "x",
        expectedPaths: ["src/routes.ts"],
        active,
        runner: new AgentRunnerImpl(
          new FakeHarness({
            script: [
              { succeed: { structuredOutput: { relevant: false, reason: "rotas diferentes" } } },
            ],
          }),
        ),
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      signal,
    );
    expect(noise.decision).toBe("isolated");
  });

  it("Lead falhando conta como relevante", async () => {
    const result = await checkFeatureOverlap(
      {
        objective: "x",
        expectedPaths: ["src/routes.ts"],
        active,
        runner: new AgentRunnerImpl(new FakeHarness({ script: [{ fail: { kind: "crash" } }] })),
        cwd: "/tmp",
        timeoutMs: 5_000,
      },
      signal,
    );
    expect(result.decision).toBe("ask_user");
  });
});
