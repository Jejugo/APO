import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@apo/observability";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerDeps } from "../server-deps.js";
import { buildServer } from "../server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execa("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd });

const FEATURE = "f1111111-1111-1111-1111-111111111111";

async function setup(status: string, withWorktree = true) {
  const root = mkdtempSync(join(tmpdir(), "apo-push-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(remote);
  await git(remote, "init", "--bare", "-q", "-b", "main");
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "remote", "add", "origin", remote);
  await execa("sh", ["-c", "echo a > a.txt"], { cwd: repo });
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "push", "-q", "origin", "main");
  const branch = `apo/f${FEATURE}/integration`;
  const path = join(worktreesRoot, FEATURE, "integration");
  if (withWorktree) {
    mkdirSync(join(worktreesRoot, FEATURE), { recursive: true });
    await git(repo, "worktree", "add", "-q", "-b", branch, path);
    await execa("sh", ["-c", "echo b > b.txt"], { cwd: path });
    await git(path, "add", "-A");
    await git(path, "commit", "-qm", "feature");
  }
  const events: unknown[] = [];
  const deps = {
    logger: createLogger({}),
    worktreesRoot,
    events: { insert: async (event: unknown) => void events.push(event) },
    features: {
      getById: async (id: string) =>
        id === FEATURE ? { id, projectId: "p1", status, prUrl: null } : undefined,
    },
  } as unknown as ServerDeps;
  return { deps, remote, branch, events };
}

describe("POST /features/:id/push — publicar a branch sem PR", () => {
  it("awaiting_approval: faz push, devolve o commit publicado e registra o evento; repetir é idempotente", async () => {
    const { deps, remote, branch, events } = await setup("awaiting_approval");
    const app = buildServer(deps);
    const response = await app.inject({ method: "POST", url: `/features/${FEATURE}/push` });
    expect(response.statusCode).toBe(200);
    expect(response.json().branch).toBe(branch);
    const remoteHead = (await git(remote, "rev-parse", branch)).stdout.trim();
    expect(response.json().commit).toBe(remoteHead);
    expect(events.map((event) => (event as { type: string }).type)).toContain(
      "feature.branch_pushed",
    );
    // idempotente
    const again = await app.inject({ method: "POST", url: `/features/${FEATURE}/push` });
    expect(again.statusCode).toBe(200);
    await app.close();
  });

  it("Feature em andamento → 409 (a branch ainda recebe merges)", async () => {
    const { deps } = await setup("executing");
    const app = buildServer(deps);
    const response = await app.inject({ method: "POST", url: `/features/${FEATURE}/push` });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("sem worktree de integração → 409; Feature inexistente → 404", async () => {
    const { deps } = await setup("awaiting_approval", false);
    const app = buildServer(deps);
    const gone = await app.inject({ method: "POST", url: `/features/${FEATURE}/push` });
    expect(gone.statusCode).toBe(409);
    const missing = await app.inject({ method: "POST", url: "/features/nada/push" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
