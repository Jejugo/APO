// Harness roteirizado (TECHNICAL_PLAN.md seção 7.1). Com ele, failover,
// recovery, paralelismo e loops de correção são testados em segundos e sem
// custo — nenhuma Task real precisa de Claude Code/Codex para ser testada.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId, ProviderId } from "@apo/domain";
import { execa } from "execa";
import type {
  AgentCapabilities,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentHarness,
  FailureKind,
  ResumeExecutionInput,
} from "../types.js";

export interface FakeHarnessStep {
  writeFile?: { path: string; content: string };
  commit?: string;
  fail?: { kind: FailureKind; resetInMs?: number };
  succeed?: { finalMessage?: string; structuredOutput?: unknown };
  delayMs?: number;
}

export interface FakeHarnessOptions {
  label?: string;
  provider?: ProviderId;
  script: FakeHarnessStep[];
}

export class FakeHarness implements AgentHarness {
  readonly id: HarnessId = "fake";
  readonly provider: ProviderId;
  private readonly label: string;
  private readonly script: readonly FakeHarnessStep[];
  private cursor = 0;

  constructor(options: FakeHarnessOptions) {
    this.provider = options.provider ?? "anthropic";
    this.label = options.label ?? "fake";
    this.script = options.script;
  }

  getCapabilities(): AgentCapabilities {
    return {
      supportsReadOnly: true,
      supportsResume: true,
      supportsOutputSchema: true,
      supportsNetworkToggle: true,
    };
  }

  async execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    const startedAt = Date.now();

    if (signal.aborted) {
      return {
        outcome: "failure",
        failure: { kind: "cancelled", message: "Cancelado antes de iniciar" },
        durationMs: 0,
      };
    }

    const step: FakeHarnessStep = this.script[this.cursor] ?? { succeed: {} };
    this.cursor += 1;

    if (step.delayMs !== undefined) {
      if (step.delayMs > input.timeoutMs) {
        // Simula o mesmo comportamento dos harnesses reais: execa aplica o
        // timeout e mata o processo antes do delay completo terminar.
        await delay(input.timeoutMs, signal);
        if (signal.aborted) {
          return {
            outcome: "failure",
            failure: { kind: "cancelled", message: "Cancelado durante a execução" },
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          outcome: "failure",
          failure: { kind: "timeout", message: `Excedeu o timeout de ${input.timeoutMs}ms` },
          durationMs: Date.now() - startedAt,
        };
      }
      await delay(step.delayMs, signal);
    }
    if (signal.aborted) {
      return {
        outcome: "failure",
        failure: { kind: "cancelled", message: "Cancelado durante a execução" },
        durationMs: Date.now() - startedAt,
      };
    }

    if (step.writeFile) {
      await writeFile(join(input.cwd, step.writeFile.path), step.writeFile.content, "utf8");
    }
    if (step.commit) {
      await execa("git", ["add", "-A"], { cwd: input.cwd });
      await execa("git", ["commit", "-m", step.commit], { cwd: input.cwd });
    }

    const durationMs = Date.now() - startedAt;
    const sessionId = `${this.label}-session-${this.cursor}`;

    if (step.fail) {
      const resetAt =
        step.fail.resetInMs !== undefined ? new Date(Date.now() + step.fail.resetInMs) : undefined;
      return {
        outcome: "failure",
        failure: {
          kind: step.fail.kind,
          message: `fake(${this.label}): falha simulada (${step.fail.kind})`,
          ...(resetAt !== undefined ? { resetAt } : {}),
        },
        sessionId,
        durationMs,
      };
    }

    return {
      outcome: "success",
      sessionId,
      ...(step.succeed?.finalMessage !== undefined
        ? { finalMessage: step.succeed.finalMessage }
        : {}),
      ...(step.succeed?.structuredOutput !== undefined
        ? { structuredOutput: step.succeed.structuredOutput }
        : {}),
      durationMs,
    };
  }

  resume(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return this.execute(input, signal);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
