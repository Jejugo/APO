import type { HarnessId, ProviderId } from "@apo/domain";
import { runSupervisedProcess } from "../run-process.js";
import type {
  AgentCapabilities,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentHarness,
  ResumeExecutionInput,
} from "../types.js";
import { buildWorkerEnvironment } from "../worker-env.js";
import { type AntigravityArgsOptions, buildAntigravityArgs } from "./build-args.js";
import { classifyAntigravityFailure, parseAntigravityJson } from "./classify-failure.js";

/** M2.23 — `agy -p` como worker single-agent. Limitações em spikes/antigravity.md. */
export class AntigravityHarness implements AgentHarness {
  readonly id: HarnessId = "antigravity";
  readonly provider: ProviderId = "google";

  constructor(private readonly options: AntigravityArgsOptions = {}) {}

  getCapabilities(): AgentCapabilities {
    return {
      // `--mode plan` segurou a escrita no spike, mas um teste não confirma.
      supportsReadOnly: false,
      supportsResume: true,
      // `--json-schema` devolve resposta vazia (T2/T2b): nunca usar como Lead.
      supportsOutputSchema: false,
      supportsNetworkToggle: false,
    };
  }

  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(input, signal, undefined, this.options);
  }

  resume(input: ResumeExecutionInput, signal: AbortSignal): Promise<AgentExecutionResult> {
    return run(input, signal, input.sessionId, this.options);
  }
}

async function run(
  input: AgentExecutionInput,
  signal: AbortSignal,
  resumeId: string | undefined,
  options: AntigravityArgsOptions,
): Promise<AgentExecutionResult> {
  const startedAt = Date.now();
  if (input.outputSchema) {
    return {
      outcome: "failure",
      failure: {
        kind: "invalid_output",
        message: "agy não entrega saída estruturada (spike M2.23)",
      },
      durationMs: 0,
    };
  }

  const result = await runSupervisedProcess({
    file: "agy",
    args: buildAntigravityArgs(input, resumeId, options),
    cwd: input.cwd,
    env: input.env ?? buildWorkerEnvironment(),
    timeoutMs: input.timeoutMs,
    signal,
    logPath: input.logPath,
    ...(input.stallTimeoutMs ? { stallTimeoutMs: input.stallTimeoutMs } : {}),
    ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
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

  const json = parseAntigravityJson(result.stdout);
  const sessionId = json?.conversation_id || resumeId;
  if (result.failed || json?.status !== "SUCCESS") {
    return {
      outcome: "failure",
      failure: classifyAntigravityFailure(json, result.stderr, result.exitCode),
      ...(sessionId ? { sessionId } : {}),
      durationMs,
    };
  }
  return {
    outcome: "success",
    ...(sessionId ? { sessionId } : {}),
    ...(json.response ? { finalMessage: json.response } : {}),
    durationMs,
  };
}
