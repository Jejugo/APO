// RoleRegistry (M2.15) — seção 4.5 do ROADMAP e 6.7 do TECHNICAL_PLAN.md.
// Role é configuração pura (id + systemPrompt + preferência de execução),
// injetada no worker efêmero pelo PromptBuilder. Os defaults embutidos podem
// ser substituídos, por id, por `<repo>/.apo/roles/*.yaml`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const RoleDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  systemPrompt: z.string().min(1),
  executionPreference: z
    .object({
      mode: z.enum(["auto", "preferred", "forced"]),
      provider: z.enum(["anthropic", "openai", "google"]).optional(),
      harness: z.enum(["claude-code", "codex", "gemini-cli", "antigravity", "fake"]).optional(),
      model: z.string().optional(),
    })
    .optional(),
});

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const GENERIC_ROLE_ID = "generic";

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    id: GENERIC_ROLE_ID,
    name: "Desenvolvedor generalista",
    description: "Fallback quando o planner não atribui role ou atribui um desconhecido.",
    systemPrompt:
      "Você é um desenvolvedor de software experiente. Siga as convenções já existentes no repositório.",
  },
  {
    id: "backend-developer",
    name: "Backend developer",
    description: "APIs, regras de negócio, persistência.",
    systemPrompt:
      "Você é um desenvolvedor backend. Priorize contratos de API claros, validação de entrada, tratamento de erro e testes das regras de negócio. Quando definir um contrato que outra Task vai consumir, descreva-o nos artifacts do relatório.",
  },
  {
    id: "frontend-developer",
    name: "Frontend developer",
    description: "UI, componentes, integração com APIs.",
    systemPrompt:
      "Você é um desenvolvedor frontend. Reaproveite componentes e padrões de estilo existentes, mantenha acessibilidade básica e consuma os contratos de API exatamente como definidos pelas Tasks de que você depende.",
  },
  {
    id: "qa-engineer",
    name: "QA engineer",
    description: "Testes automatizados.",
    systemPrompt:
      "Você é um engenheiro de qualidade. Escreva testes automatizados que cubram o comportamento pedido e casos de borda relevantes, sem alterar código de produção além do mínimo necessário para testabilidade.",
  },
];

/** Defaults embutidos + overrides do Project (`.apo/roles/*.yaml`), por id. */
export function loadRoleRegistry(repoPath: string): Map<string, RoleDefinition> {
  const registry = new Map(DEFAULT_ROLES.map((role) => [role.id, role]));
  const dir = join(repoPath, ".apo", "roles");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
  } catch {
    return registry;
  }
  for (const file of files) {
    const raw = parseYaml(readFileSync(join(dir, file), "utf8")) as unknown;
    const role = RoleDefinitionSchema.parse(raw);
    registry.set(role.id, role);
  }
  return registry;
}
