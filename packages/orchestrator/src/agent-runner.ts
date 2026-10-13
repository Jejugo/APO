// AgentRunner (TECHNICAL_PLAN.md seção 6.8) — generaliza o que seria o
// LeadRunner. M1: só a persona "lead" existe, com um systemPrompt fixo
// (PERSONAS abaixo) em vez de vir de um RoleRegistry — isso só chega no
// M2.15/M2.16. A resolução de harness (ExecutionTargetResolver) também só
// chega no M3; por isso o AgentRunner recebe um AgentHarness já resolvido,
// não resolve ele mesmo.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentFailure, AgentHarness, JsonSchema } from "@apo/harnesses";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface PersonaDefinition {
  systemPrompt: string;
}

// M1: só "lead". product-owner/cto chegam no M3 via team.yaml (seção 4.6 do
// ROADMAP) — ver TECHNICAL_PLAN.md seção 6.8, "Onde entra".
export const PERSONAS: Record<string, PersonaDefinition> = {
  lead: {
    systemPrompt:
      "Você é o Lead do orquestrador APO. Sua função aqui é julgamento estruturado " +
      "em modo read-only: leia o que for necessário no repositório e responda SOMENTE " +
      "com um JSON que satisfaça o schema pedido, sem nenhum texto antes ou depois.",
  },
  // M4.3 — revisor independente da implementação.
  reviewer: {
    systemPrompt:
      "Você é o Reviewer do orquestrador APO: um revisor de código sênior, cético e objetivo. " +
      "Você não implementou esta mudança. Trabalhe em modo read-only e responda SOMENTE com um " +
      "JSON que satisfaça o schema pedido, sem nenhum texto antes ou depois.",
  },
};

export interface AgentRunInput<T> {
  prompt: string;
  cwd: string;
  schema: z.ZodType<T>;
  timeoutMs: number;
  model?: string;
  maxRetries?: number;
}

export interface AgentRunResult<T> {
  outcome: "success" | "failure";
  output?: T;
  failure?: AgentFailure;
  attempts: number;
}

export interface AgentRunner {
  run<T>(persona: string, input: AgentRunInput<T>, signal: AbortSignal): Promise<AgentRunResult<T>>;
}

export class AgentRunnerImpl implements AgentRunner {
  constructor(
    private readonly harness: AgentHarness,
    private readonly personas: Record<string, PersonaDefinition> = PERSONAS,
    /** Modelo e esforço do target escolhido (sem isto, o CLI usa o modelo padrão dele). */
    private readonly defaults: { model?: string | undefined; effort?: string | undefined } = {},
  ) {}

  async run<T>(
    persona: string,
    input: AgentRunInput<T>,
    signal: AbortSignal,
  ): Promise<AgentRunResult<T>> {
    const personaDef = this.personas[persona];
    if (!personaDef) {
      throw new Error(`AgentRunner: persona desconhecida "${persona}"`);
    }

    const jsonSchema = zodToJsonSchema(input.schema) as JsonSchema;
    const maxAttempts = (input.maxRetries ?? 1) + 1;
    let lastFailure: AgentFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? `${personaDef.systemPrompt}\n\n${input.prompt}`
          : `${personaDef.systemPrompt}\n\n${input.prompt}\n\nA resposta anterior não era um JSON válido para o schema pedido. Responda de novo, só com o JSON, sem nenhum texto adicional.`;

      const result = await this.harness.execute(
        {
          prompt,
          cwd: input.cwd,
          mode: "read-only",
          networkAccess: false,
          outputSchema: jsonSchema,
          timeoutMs: input.timeoutMs,
          logPath: await agentRunnerLogPath(),
          ...(input.model !== undefined || this.defaults.model !== undefined
            ? { model: (input.model ?? this.defaults.model) as string }
            : {}),
          ...(this.defaults.effort !== undefined ? { effort: this.defaults.effort } : {}),
        },
        signal,
      );

      if (result.outcome === "failure") {
        if (result.failure?.kind !== "invalid_output") {
          return {
            outcome: "failure",
            ...(result.failure ? { failure: result.failure } : {}),
            attempts: attempt,
          };
        }
        lastFailure = result.failure;
        continue;
      }

      const parsed = input.schema.safeParse(result.structuredOutput);
      if (parsed.success) {
        return { outcome: "success", output: parsed.data, attempts: attempt };
      }
      lastFailure = { kind: "invalid_output", message: parsed.error.message };
    }

    return {
      outcome: "failure",
      ...(lastFailure ? { failure: lastFailure } : {}),
      attempts: maxAttempts,
    };
  }
}

async function agentRunnerLogPath(): Promise<string> {
  const dir = join(homedir(), ".apo", "logs", "agent-runner");
  await mkdir(dir, { recursive: true });
  return join(dir, `${randomUUID()}.log`);
}
