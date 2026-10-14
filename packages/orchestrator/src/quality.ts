// QualityGateRunner (M4.1) — seção 24 do PLAN.md. Roda os comandos do
// project.yaml na worktree de integração, em ordem fixa: build → lint →
// typecheck → tests. Sem comando configurado o gate fica `skipped` e não
// bloqueia (regra 6 do PLAN.md). Para no primeiro gate que falha: os seguintes
// costumam falhar pelo mesmo motivo e só poluiriam a Task corretiva.

import { execa } from "execa";
import { loadProjectConfig, prepareWorktree } from "./verify.js";

export const QUALITY_GATES = ["build", "lint", "typecheck", "tests"] as const;
export type QualityGate = (typeof QUALITY_GATES)[number];

export interface GateResult {
  gate: QualityGate | "prepare";
  status: "passed" | "failed" | "skipped";
  command?: string;
  output?: string;
  durationMs: number;
}

const OUTPUT_TAIL = 4000;

/** Acompanhamento ao vivo (`apo watch`): início, saída e fim de cada etapa. */
export interface QualityGateHooks {
  onStart?(gate: GateResult["gate"], command?: string): void;
  onOutput?(gate: GateResult["gate"], chunk: string): void;
  onFinish?(result: GateResult): void;
}

export async function runQualityGates(
  repoPath: string,
  integrationPath: string,
  env?: Record<string, string>,
  hooks: QualityGateHooks = {},
): Promise<GateResult[]> {
  const commands = loadProjectConfig(repoPath).quality?.commands ?? {};
  const results: GateResult[] = [];

  if (QUALITY_GATES.some((gate) => commands[gate])) {
    const started = Date.now();
    const prepareCommand = loadProjectConfig(repoPath).workspace?.prepare;
    if (prepareCommand) hooks.onStart?.("prepare", prepareCommand);
    const prepared = await prepareWorktree(repoPath, integrationPath, env, (chunk) =>
      hooks.onOutput?.("prepare", chunk),
    );
    if (prepareCommand) {
      hooks.onFinish?.({
        gate: "prepare",
        status: prepared.passed ? "passed" : "failed",
        command: prepareCommand,
        durationMs: Date.now() - started,
      });
    }
    if (!prepared.passed) {
      results.push({
        gate: "prepare",
        status: "failed",
        output: prepared.reason ?? "",
        durationMs: Date.now() - started,
      });
      return results;
    }
  }

  for (const gate of QUALITY_GATES) {
    const command = commands[gate];
    if (!command) {
      results.push({ gate, status: "skipped", durationMs: 0 });
      continue;
    }
    const started = Date.now();
    hooks.onStart?.(gate, command);
    const process = execa(command, {
      cwd: integrationPath,
      shell: true,
      reject: false,
      all: true,
      ...(env ? { env, extendEnv: false } : {}),
    });
    process.all?.on("data", (chunk: Buffer) => hooks.onOutput?.(gate, chunk.toString("utf8")));
    const run = await process;
    const passed = run.exitCode === 0;
    const result: GateResult = {
      gate,
      status: passed ? "passed" : "failed",
      command,
      output: (run.all ?? "").slice(-OUTPUT_TAIL),
      durationMs: Date.now() - started,
    };
    results.push(result);
    hooks.onFinish?.(result);
    if (!passed) break;
  }
  return results;
}
