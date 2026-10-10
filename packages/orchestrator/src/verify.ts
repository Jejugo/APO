// Verificação da Feature (M1.11, estendida no M2): roda na worktree de
// integração, depois que todas as Tasks foram integradas. Há commits novos em
// relação à branch padrão + o comando de testes do project.yaml passa. Sem
// comando configurado, não bloqueia (regra 6 do PLAN.md). Os quality gates
// completos (build/lint/typecheck, completion contract) são o M4.

import { join } from "node:path";
import { ProjectConfigSchema, loadConfig } from "@apo/config";
import { execa } from "execa";
import { hasNewCommits } from "./worktree.js";

export interface VerifyResult {
  passed: boolean;
  reason?: string;
}

export function loadProjectConfig(repoPath: string) {
  return loadConfig(join(repoPath, ".apo", "project.yaml"), ProjectConfigSchema);
}

async function runShell(command: string, cwd: string, env?: Record<string, string>) {
  return execa(command, {
    cwd,
    shell: true,
    reject: false,
    ...(env ? { env, extendEnv: false } : {}),
  });
}

/** `workspace.prepare` do project.yaml (ex.: "pnpm install") numa worktree. */
export async function prepareWorktree(
  repoPath: string,
  worktreePath: string,
  env?: Record<string, string>,
): Promise<VerifyResult> {
  const command = loadProjectConfig(repoPath).workspace?.prepare;
  if (!command) return { passed: true };
  const result = await runShell(command, worktreePath, env);
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    return {
      passed: false,
      reason: `prepare falhou (exit ${result.exitCode}): ${command}\n${output}`,
    };
  }
  return { passed: true };
}

export async function verifyIntegration(
  repoPath: string,
  integrationPath: string,
  defaultBranch: string,
  env?: Record<string, string>,
): Promise<VerifyResult> {
  if (!(await hasNewCommits(integrationPath, defaultBranch))) {
    return { passed: false, reason: "nenhum commit novo na branch de integração" };
  }

  const testsCommand = loadProjectConfig(repoPath).quality?.commands?.tests;
  if (!testsCommand) {
    return { passed: true };
  }

  const prepared = await prepareWorktree(repoPath, integrationPath, env);
  if (!prepared.passed) return prepared;

  const result = await runShell(testsCommand, integrationPath, env);
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    return {
      passed: false,
      reason: `comando de testes falhou (exit ${result.exitCode}): ${testsCommand}\n${output}`,
    };
  }
  return { passed: true };
}
