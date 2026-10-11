// planChangeRequests (M4.6). Um worker que descobre que o plano está
// incompleto pede, no WorkerReport, uma mudança; o Lead decide: criar Task,
// rejeitar com motivo, ou pedir ao humano. Tudo fica em agent_messages
// (`type: "plan_change_request"`).

import { z } from "zod";
import type { AgentRunner } from "./agent-runner.js";

export const PLAN_CHANGE_REQUEST = "plan_change_request";

export const PlanChangeRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  reason: z.string().min(1),
});
export type PlanChangeRequest = z.infer<typeof PlanChangeRequestSchema>;

export const PlanChangeDecisionSchema = z.object({
  decision: z.enum(["create_task", "reject", "ask_human"]),
  reason: z.string().min(1),
  task: z
    .object({
      title: z.string().min(1),
      description: z.string().min(1),
      kind: z.enum(["read", "write"]),
      role: z.string().min(1),
      expectedPaths: z.array(z.string()),
    })
    .optional(),
});
export type PlanChangeDecision = z.infer<typeof PlanChangeDecisionSchema>;

export async function decidePlanChange(
  runner: AgentRunner,
  input: {
    objective: string;
    request: PlanChangeRequest;
    existingTasks: string[];
    roleIds: string[];
    cwd: string;
    timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<PlanChangeDecision | undefined> {
  const result = await runner.run(
    "lead",
    {
      prompt: [
        "Um worker pediu uma mudança no plano desta Feature. Decida:",
        '- "create_task": o pedido é necessário para o objetivo; descreva a Task nova em `task`;',
        '- "reject": desnecessário, fora do escopo ou já coberto por uma Task existente;',
        '- "ask_human": muda o escopo ou exige uma decisão de produto que não cabe a você.',
        `Roles válidos: ${input.roleIds.join(", ")}.`,
        `Objetivo da Feature: ${input.objective}`,
        `Tasks existentes:\n${input.existingTasks.map((task) => `- ${task}`).join("\n")}`,
        `Pedido: ${input.request.title}\n${input.request.description}\nMotivo: ${input.request.reason}`,
      ].join("\n\n"),
      cwd: input.cwd,
      schema: PlanChangeDecisionSchema,
      timeoutMs: input.timeoutMs,
    },
    signal,
  );
  if (result.outcome !== "success" || !result.output) return undefined;
  if (result.output.decision === "create_task" && !result.output.task) return undefined;
  return result.output;
}
