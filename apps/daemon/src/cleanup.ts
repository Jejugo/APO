// M6.8 — limpeza no boot, antes do recovery:
// 1. workers órfãos: CLIs de agente que sobraram de um daemon que caiu no meio
//    de um attempt (o recovery vai refazer o attempt; o órfão só gastaria
//    quota e escreveria na worktree em paralelo);
// 2. worktrees de Features que não existem mais ou já terminaram.
//
// Matar processo é a parte perigosa: um PID velho pode ter sido reaproveitado
// por outro processo do usuário. Só morre o que satisfaz as três condições:
// comando de agente conhecido, órfão (pai = 1) e cwd dentro das worktrees.
// Sob systemd, o cgroup do serviço já garante isso no stop/restart.

import { readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FeatureRepository, ProjectRepository } from "@apo/db";
import type { Logger } from "@apo/observability";
import { execa } from "execa";

const AGENT_COMMANDS = /(^|\/)(claude|codex|agy)(\s|$)/;
const DONE_STATUSES = new Set(["completed", "cancelled", "failed"]);

export interface ProcessInfo {
  ppid: number;
  command: string;
  cwd: string | undefined;
}

async function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  const ps = await execa("ps", ["-o", "ppid=,command=", "-p", String(pid)], { reject: false });
  const line = ps.stdout.trim();
  if (ps.exitCode !== 0 || !line) return undefined;
  const match = /^(\d+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  let cwd: string | undefined;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const lsof = await execa("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      reject: false,
    });
    cwd = lsof.stdout
      .split("\n")
      .find((entry) => entry.startsWith("n"))
      ?.slice(1);
  }
  return { ppid: Number(match[1]), command: match[2] ?? "", cwd };
}

export function isOrphanWorker(info: ProcessInfo, worktreesRoot: string): boolean {
  const root = resolve(worktreesRoot) + sep;
  return (
    info.ppid === 1 &&
    AGENT_COMMANDS.test(info.command) &&
    info.cwd !== undefined &&
    `${resolve(info.cwd)}${sep}`.startsWith(root)
  );
}

async function killTree(pid: number): Promise<void> {
  const children = await execa("pgrep", ["-P", String(pid)], { reject: false });
  for (const child of children.stdout.split("\n").filter(Boolean)) {
    await killTree(Number(child));
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // já saiu
  }
}

export async function killOrphanWorkers(
  runsRoot: string,
  worktreesRoot: string,
  logger: Logger,
  inspect: (pid: number) => Promise<ProcessInfo | undefined> = processInfo,
): Promise<number[]> {
  const killed: number[] = [];
  let runs: string[] = [];
  try {
    runs = readdirSync(runsRoot);
  } catch {
    return killed;
  }
  for (const run of runs) {
    const pidFile = join(runsRoot, run, "worker.pid");
    let pid: number;
    try {
      pid = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      continue;
    }
    const info = Number.isInteger(pid) && pid > 1 ? await inspect(pid) : undefined;
    if (info && isOrphanWorker(info, worktreesRoot)) {
      await killTree(pid);
      killed.push(pid);
      logger.warn(
        { pid, attempt: run, command: info.command.slice(0, 120) },
        "boot: worker órfão encerrado",
      );
    }
    rmSync(pidFile, { force: true });
  }
  return killed;
}

export async function removeOrphanWorktrees(
  deps: { features: FeatureRepository; projects: ProjectRepository; logger: Logger },
  worktreesRoot: string,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(worktreesRoot).filter((name) =>
      statSync(join(worktreesRoot, name)).isDirectory(),
    );
  } catch {
    return removed;
  }
  const repos = new Set<string>();
  for (const featureId of entries) {
    const feature = await deps.features.getById(featureId);
    if (feature && !DONE_STATUSES.has(feature.status)) continue;
    const project = feature ? await deps.projects.getById(feature.projectId) : undefined;
    const dir = join(worktreesRoot, featureId);
    if (project) {
      repos.add(project.repoPath);
      for (const child of readdirSync(dir)) {
        await execa("git", ["worktree", "remove", "--force", join(dir, child)], {
          cwd: project.repoPath,
          reject: false,
        });
      }
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(featureId);
  }
  for (const repo of repos) {
    await execa("git", ["worktree", "prune"], { cwd: repo, reject: false });
  }
  if (removed.length > 0) {
    deps.logger.info({ count: removed.length }, "boot: worktrees de Features encerradas removidas");
  }
  return removed;
}
