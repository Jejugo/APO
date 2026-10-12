// WorktreeManager (M2.1) e integração de branches (M2.7/M2.8).
//
// Layout em disco (seção 3.2): <worktreesRoot>/<featureId>/integration e
// <worktreesRoot>/<featureId>/<taskId>. Branches:
//   apo/f<feature>/integration        — onde o trabalho da Feature se junta
//   apo/f<feature>/t<n>-<slug>        — uma por Task que escreve
//
// Toda operação que mexe em refs/worktrees do repositório passa por um lock
// por repo: `git worktree add` concorrente no mesmo repo disputa locks do .git.
//
// (O TECHNICAL_PLAN previa um `packages/git` próprio; com um único consumidor,
// fica aqui até existir um segundo — regra 3 do PLAN.md.)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  repoLocks.set(
    repoPath,
    next.catch(() => undefined),
  );
  return next;
}

export function integrationBranchName(featureId: string): string {
  return `apo/f${featureId}/integration`;
}

export function taskBranchName(featureId: string, seq: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `apo/f${featureId}/t${seq}-${slug}`;
}

export function integrationWorktreePath(worktreesRoot: string, featureId: string): string {
  return join(worktreesRoot, featureId, "integration");
}

export function taskWorktreePath(worktreesRoot: string, featureId: string, taskId: string): string {
  return join(worktreesRoot, featureId, taskId);
}

async function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd, reject: false });
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

/** Idempotente: reaproveita a worktree se já existir (recovery). */
async function ensureWorktree(
  repoPath: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (existsSync(path)) return;
  await withRepoLock(repoPath, async () => {
    if (existsSync(path)) return;
    const args = (await branchExists(repoPath, branch))
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, baseRef];
    const result = await git(repoPath, args);
    if (result.exitCode !== 0) {
      throw new Error(`git worktree add falhou (${path}): ${result.stderr}`);
    }
  });
}

export type BaseSyncResult =
  | { status: "updated" | "up_to_date"; from: string; to: string }
  | { status: "no_remote" }
  | { status: "failed"; reason: string };

/**
 * Traz a branch base do remoto antes de uma Feature nova começar. Sem isso,
 * depois de um merge no GitHub a Feature seguinte partiria do código antigo do
 * clone (achado no uso pelo homelab). Só fast-forward: o clone do APO é um
 * espelho e nunca recebe commits locais na base; se divergir, não força nada.
 */
export async function syncBaseBranch(
  repoPath: string,
  baseBranch: string,
): Promise<BaseSyncResult> {
  return withRepoLock(repoPath, async () => {
    const remote = await git(repoPath, ["remote", "get-url", "origin"]);
    if (remote.exitCode !== 0) return { status: "no_remote" };
    const fetched = await git(repoPath, ["fetch", "--quiet", "origin", baseBranch]);
    if (fetched.exitCode !== 0)
      return { status: "failed", reason: fetched.stderr.trim().slice(0, 300) };
    const before = (await git(repoPath, ["rev-parse", baseBranch])).stdout.trim();
    const current = (await git(repoPath, ["branch", "--show-current"])).stdout.trim();
    // Base em checkout (o normal num clone): merge --ff-only atualiza ref e
    // arquivos. Fora de checkout: atualiza só a ref, se for fast-forward.
    const updated =
      current === baseBranch
        ? await git(repoPath, ["merge", "--ff-only", "--quiet", `origin/${baseBranch}`])
        : await git(repoPath, ["fetch", "--quiet", "origin", `${baseBranch}:${baseBranch}`]);
    if (updated.exitCode !== 0) {
      return {
        status: "failed",
        reason: updated.stderr.trim().slice(0, 300) || "não é fast-forward",
      };
    }
    const after = (await git(repoPath, ["rev-parse", baseBranch])).stdout.trim();
    return { status: before === after ? "up_to_date" : "updated", from: before, to: after };
  });
}

export async function ensureIntegrationWorktree(
  repoPath: string,
  worktreesRoot: string,
  featureId: string,
  defaultBranch: string,
): Promise<{ path: string; branch: string }> {
  const path = integrationWorktreePath(worktreesRoot, featureId);
  const branch = integrationBranchName(featureId);
  await ensureWorktree(repoPath, path, branch, defaultBranch);
  return { path, branch };
}

/** A Task nasce do HEAD de integração, para enxergar o código das dependências (M2.7). */
export async function ensureTaskWorktree(
  repoPath: string,
  worktreesRoot: string,
  featureId: string,
  taskId: string,
  branch: string,
): Promise<string> {
  const path = taskWorktreePath(worktreesRoot, featureId, taskId);
  await ensureWorktree(repoPath, path, branch, integrationBranchName(featureId));
  return path;
}

export type MergeResult =
  | { status: "merged" | "already_merged" }
  | { status: "conflict"; files: string[] };

/** Merge `--no-ff` da branch da Task na integração. Em conflito: `merge --abort` (M2.8). */
export async function mergeIntoIntegration(
  integrationPath: string,
  branch: string,
  message: string,
): Promise<MergeResult> {
  const ancestor = await git(integrationPath, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (ancestor.exitCode === 0) return { status: "already_merged" };

  const merge = await git(integrationPath, ["merge", "--no-ff", "-m", message, branch]);
  if (merge.exitCode === 0) return { status: "merged" };

  const conflicted = await git(integrationPath, ["diff", "--name-only", "--diff-filter=U"]);
  await git(integrationPath, ["merge", "--abort"]);
  return { status: "conflict", files: conflicted.stdout.split("\n").filter(Boolean) };
}

/** Reproduz o conflito na integração para a Task corretiva resolver (sem commitar). */
export async function startConflictMerge(integrationPath: string, branch: string): Promise<void> {
  const inProgress = await git(integrationPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (inProgress.exitCode === 0) return;
  await git(integrationPath, ["merge", "--no-ff", "--no-commit", branch]);
}

export async function abortMergeIfAny(path: string): Promise<void> {
  const inProgress = await git(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (inProgress.exitCode === 0) {
    await git(path, ["merge", "--abort"]);
  }
}

export async function hasConflictMarkers(path: string): Promise<boolean> {
  const unmerged = await git(path, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.stdout.trim().length > 0) return true;
  const grep = await git(path, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) "]);
  return grep.stdout.trim().length > 0;
}

export async function hasNewCommits(worktreePath: string, baseRef: string): Promise<boolean> {
  const result = await git(worktreePath, ["rev-list", "--count", `${baseRef}..HEAD`]);
  return Number(result.stdout.trim()) > 0;
}

export async function changedPathsSince(worktreePath: string, baseRef: string): Promise<string[]> {
  const base = await git(worktreePath, ["merge-base", "HEAD", baseRef]);
  const result = await git(worktreePath, ["diff", "--name-only", `${base.stdout.trim()}..HEAD`]);
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Git/commit é responsabilidade determinística da infraestrutura, não do
 * agente (regra 10 do PLAN.md; seção 6.3). Confirmado necessário na validação
 * do M1: o Claude Code escreveu os arquivos pedidos mas não comitou. Com um
 * merge em andamento (Task corretiva), o commit conclui o merge.
 */
export async function commitIfDirty(worktreePath: string, message: string): Promise<boolean> {
  const status = await git(worktreePath, ["status", "--porcelain"]);
  if (status.stdout.trim().length === 0) {
    const merging = await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (merging.exitCode !== 0) return false;
  }
  await git(worktreePath, ["add", "-A"]);
  const commit = await git(worktreePath, ["commit", "-m", message]);
  return commit.exitCode === 0;
}
