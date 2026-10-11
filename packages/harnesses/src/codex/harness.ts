import type { HarnessId, ProviderId } from "@apo/domain";
import { detectLimitFailure } from "../limit-detection.js";
import { runSupervisedProcess } from "../run-process.js";
import type {
  AgentCapabilities,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentHarness,
  ResumeExecutionInput,
} from "../types.js";
import { buildWorkerEnvironment } from "../worker-env.js";
import { buildCodexArgs } from "./build-args.js";
import {
  classifyCodexFailure,
  findCodexThreadId,
  findCodexTurnFailed,
  parseCodexJsonl,
} from "./classify-failure.js";
import { stripIntroducedNulls } from "./strict-schema.js";
import { prepareCodexTempFiles, readLastMessage } from "./temp-files.js";

export class CodexHarness implements AgentHarness {
  readonly id: HarnessId = "codex";
  readonly provider: ProviderId = "openai";

  getCapabilities(): AgentCapabilities {
    return {
      supportsReadOnly: true,
      supportsResume: true,
      supportsOutputSchema: true,
      // Confirmado no spike M0.10: liberar com -c sandbox_workspace_write.network_access=true.
      supportsNetworkToggle: true,
    };
  }

  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(input, signal);
  }

  resume(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(input, signal, input.sessionId);
  }
}

async function run(
  input: AgentExecutionInput,
  signal: AbortSignal,
  resumeThreadId?: string,
): Promise<AgentExecutionResult> {
  const startedAt = Date.now();
  const temp = await prepareCodexTempFiles(input.outputSchema);

  try {
    const args = buildCodexArgs(input, {
      outputLastMessagePath: temp.outputLastMessagePath,
      ...(temp.outputSchemaPath !== undefined ? { outputSchemaPath: temp.outputSchemaPath } : {}),
      ...(resumeThreadId !== undefined ? { resumeThreadId } : {}),
    });

    const result = await runSupervisedProcess({
      file: "codex",
      args,
      cwd: input.cwd,
      env: input.env ?? buildWorkerEnvironment(),
      timeoutMs: input.timeoutMs,
      signal,
      logPath: input.logPath,
      ...(input.stallTimeoutMs ? { stallTimeoutMs: input.stallTimeoutMs } : {}),
    });

    const durationMs = Date.now() - startedAt;

    if (result.stalled) {
      return {
        outcome: "failure",
        failure: {
          kind: "stalled",
          message: `Sem saída nem escrita em disco por ${input.stallTimeoutMs}ms`,
        },
        durationMs,
      };
    }
    if (result.timedOut) {
      return {
        outcome: "failure",
        failure: { kind: "timeout", message: `Excedeu o timeout de ${input.timeoutMs}ms` },
        durationMs,
      };
    }
    if (result.canceled) {
      return {
        outcome: "failure",
        failure: { kind: "cancelled", message: "Cancelado via AbortSignal" },
        durationMs,
      };
    }

    const events = parseCodexJsonl(result.stdout);
    const threadId = findCodexThreadId(events) ?? resumeThreadId;
    const turnFailed = findCodexTurnFailed(events);

    if (turnFailed) {
      return {
        outcome: "failure",
        failure: classifyCodexFailure(turnFailed),
        ...(threadId !== undefined ? { sessionId: threadId } : {}),
        durationMs,
      };
    }

    if (result.failed) {
      return {
        outcome: "failure",
        failure: detectLimitFailure(`${result.stderr}\n${result.stdout}`) ?? {
          kind: "crash",
          message:
            result.stderr.length > 0
              ? result.stderr
              : `codex exec terminou com exit ${result.exitCode}`,
        },
        ...(threadId !== undefined ? { sessionId: threadId } : {}),
        durationMs,
      };
    }

    const finalMessage = await readLastMessage(temp.outputLastMessagePath);

    let structuredOutput: unknown;
    if (input.outputSchema && finalMessage !== undefined) {
      try {
        structuredOutput = stripIntroducedNulls(JSON.parse(finalMessage), input.outputSchema);
      } catch {
        return {
          outcome: "failure",
          failure: {
            kind: "invalid_output",
            message: "A saída não é um JSON válido para o outputSchema pedido",
          },
          ...(threadId !== undefined ? { sessionId: threadId } : {}),
          durationMs,
        };
      }
    }

    return {
      outcome: "success",
      ...(threadId !== undefined ? { sessionId: threadId } : {}),
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      durationMs,
    };
  } finally {
    await temp.cleanup();
  }
}
