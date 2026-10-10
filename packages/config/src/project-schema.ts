import { z } from "zod";

// <repo>/.apo/project.yaml — config do Project (seção 24 do PLAN.md,
// seção 4.1 do ROADMAP.md).

export const QualityCommandsSchema = z.object({
  build: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  tests: z.string().optional(),
});

export const WorkspaceModeSchema = z.enum(["shared", "isolated", "auto"]);

export const ProjectConfigSchema = z.object({
  quality: z
    .object({
      commands: QualityCommandsSchema.default({}),
    })
    .default({}),
  git: z
    .object({
      requirePrApproval: z.boolean().default(true),
    })
    .default({}),
  workspace: z
    .object({
      defaultMode: WorkspaceModeSchema.default("auto"),
      // Rodado em cada worktree nova (Task e integração) antes do trabalho e
      // dos testes — ex.: "pnpm install". Worktrees não herdam node_modules.
      prepare: z.string().optional(),
    })
    .default({}),
  // Variáveis extras que o worker pode enxergar, além da allowlist base
  // (seção 6.3 do TECHNICAL_PLAN.md). Ex.: NPM_TOKEN para um registry privado.
  worker: z
    .object({
      env: z.object({ allow: z.array(z.string()).default([]) }).default({}),
    })
    .default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
