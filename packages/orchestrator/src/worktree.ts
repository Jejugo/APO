// Workspace mínimo (M1.10) — uma worktree por Feature. O WorktreeManager
// completo (M2.1), com worktree por Task, cleanup e detecção de órfãs, só
// chega quando o DAG de múltiplas Tasks existir.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

export interface FeatureWorktree {
  worktreePath: string;
  branch: string;
}

export function featureBranch(featureId: string): string {
  return `apo/f${featureId}/main`;
}

/** Idempotente: se a worktree já existe em disco (ex.: recovery após restart do daemon), reaproveita. */
export async function ensureFeatureWorktree(
  repoPath: string,
  worktreesRoot: string,
  featureId: string,
  defaultBranch: string,
): Promise<FeatureWorktree> {
  const branch = featureBranch(featureId);
  const worktreePath = join(worktreesRoot, featureId);

  if (existsSync(worktreePath)) {
    return { worktreePath, branch };
  }

  await execa("git", ["worktree", "add", "-b", branch, worktreePath, defaultBranch], {
    cwd: repoPath,
  });
  return { worktreePath, branch };
}

export async function hasNewCommits(worktreePath: string, defaultBranch: string): Promise<boolean> {
  const result = await execa("git", ["rev-list", "--count", `${defaultBranch}..HEAD`], {
    cwd: worktreePath,
  });
  return Number(result.stdout.trim()) > 0;
}

/**
 * Git/commit é responsabilidade determinística da infraestrutura, não do
 * agente (regra 10 do PLAN.md; TECHNICAL_PLAN.md seção 6.3: "working tree
 * suja → o WorkerManager faz um commit wip"). Confirmado necessário em
 * execução real: o Claude Code escreveu os arquivos pedidos mas não comitou
 * por conta própria. Retorna `true` se um commit novo foi criado.
 */
export async function commitIfDirty(worktreePath: string, message: string): Promise<boolean> {
  const status = await execa("git", ["status", "--porcelain"], { cwd: worktreePath });
  if (status.stdout.trim().length === 0) {
    return false;
  }
  await execa("git", ["add", "-A"], { cwd: worktreePath });
  await execa("git", ["commit", "-m", message], { cwd: worktreePath });
  return true;
}
