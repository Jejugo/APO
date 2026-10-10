import { join } from "node:path";
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
import { buildClaudeCodeArgs } from "./build-args.js";
import { type ClaudeCodeResultJson, classifyClaudeCodeFailure } from "./classify-failure.js";

export class ClaudeCodeHarness implements AgentHarness {
  readonly id: HarnessId = "claude-code";
  readonly provider: ProviderId = "anthropic";

  getCapabilities(): AgentCapabilities {
    return {
      supportsReadOnly: true,
      supportsResume: true,
      supportsOutputSchema: true,
      // Confirmado no spike M0.9: Claude Code não sandboxa rede em nenhum modo.
      supportsNetworkToggle: false,
    };
  }

  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(buildClaudeCodeArgs(input), input, signal);
  }

  resume(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(buildClaudeCodeArgs(input, input.sessionId), input, signal);
  }
}

async function run(
  args: string[],
  input: AgentExecutionInput,
  signal: AbortSignal,
): Promise<AgentExecutionResult> {
  const startedAt = Date.now();
  const env = input.env ?? buildWorkerEnvironment();

  const result = await runSupervisedProcess({
    file: "claude",
    args,
    cwd: input.cwd,
    env,
    timeoutMs: input.timeoutMs,
    signal,
    logPath: input.logPath,
    ...(input.stallTimeoutMs ? { stallTimeoutMs: input.stallTimeoutMs } : {}),
    // Em `--output-format json` o stdout fica mudo até o fim; o transcript da
    // sessão em ~/.claude/projects é o sinal de vida.
    activityPaths: env.HOME ? [join(env.HOME, ".claude", "projects")] : [],
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

  let json: ClaudeCodeResultJson;
  try {
    json = JSON.parse(result.stdout) as ClaudeCodeResultJson;
  } catch {
    const raw = `${result.stdout}\n${result.stderr}`;
    return {
      outcome: "failure",
      failure: detectLimitFailure(raw) ?? {
        kind: "crash",
        message: `Saída não é JSON válido (exit ${result.exitCode}): ${raw.slice(0, 500)}`,
      },
      durationMs,
    };
  }

  const failure = classifyClaudeCodeFailure(json);
  if (failure) {
    return {
      outcome: "failure",
      failure,
      ...(json.session_id !== undefined ? { sessionId: json.session_id } : {}),
      durationMs,
    };
  }

  let structuredOutput: unknown;
  if (input.outputSchema && json.result !== undefined) {
    try {
      structuredOutput = JSON.parse(json.result);
    } catch {
      return {
        outcome: "failure",
        failure: {
          kind: "invalid_output",
          message: "A saída não é um JSON válido para o outputSchema pedido",
        },
        ...(json.session_id !== undefined ? { sessionId: json.session_id } : {}),
        durationMs,
      };
    }
  }

  return {
    outcome: "success",
    ...(json.session_id !== undefined ? { sessionId: json.session_id } : {}),
    ...(json.result !== undefined ? { finalMessage: json.result } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    durationMs,
  };
}
