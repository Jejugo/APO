// Verify mínimo (M1.11): há commits novos na branch + o comando de testes do
// project.yaml passa. Sem comando configurado, não bloqueia (regra 6 do
// PLAN.md: o sistema continua funcionando com dado incompleto).

import { join } from "node:path";
import { ProjectConfigSchema, loadConfig } from "@apo/config";
import { execa } from "execa";
import { hasNewCommits } from "./worktree.js";

export interface VerifyResult {
  passed: boolean;
  reason?: string;
}

export async function verifyTask(
  repoPath: string,
  worktreePath: string,
  defaultBranch: string,
): Promise<VerifyResult> {
  const hasCommits = await hasNewCommits(worktreePath, defaultBranch);
  if (!hasCommits) {
    return { passed: false, reason: "nenhum commit novo na branch" };
  }

  const projectConfig = loadConfig(join(repoPath, ".apo", "project.yaml"), ProjectConfigSchema);
  const testsCommand = projectConfig.quality?.commands?.tests;
  if (!testsCommand) {
    return { passed: true };
  }

  const result = await execa(testsCommand, { cwd: worktreePath, shell: true, reject: false });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    return {
      passed: false,
      reason: `comando de testes falhou (exit ${result.exitCode}): ${testsCommand}\n${output}`,
    };
  }
  return { passed: true };
}
