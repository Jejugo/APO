import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@apo/observability";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerDeps } from "../server-deps.js";
import { buildServer } from "../server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "apo-proj-"));
  dirs.push(root);
  const path = join(root, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

function deps(existing: Array<{ id: string; name: string; repoPath: string }> = []) {
  const created: Array<{ name: string; repoPath: string }> = [];
  const stub = {
    logger: createLogger({}),
    events: { insert: async () => undefined },
    projects: {
      getByRepoPath: async () => undefined,
      list: async () => [...existing, ...created.map((row) => ({ id: row.name, ...row }))],
      create: async (input: { name: string; repoPath: string }) => {
        created.push(input);
        return { ...input, id: `id-${input.name}`, defaultBranch: "main" };
      },
    },
    projectAgents: { create: async () => undefined },
  } as unknown as ServerDeps;
  return { stub, created };
}

describe("POST /projects — nome do Project", () => {
  it("usa o nome da pasta por padrão e aceita --name", async () => {
    const { stub, created } = deps();
    const app = buildServer(stub);
    const first = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { repoPath: repo("app") },
    });
    const second = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { repoPath: repo("app"), name: "app-fork" },
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(created.map((row) => row.name)).toEqual(["app", "app-fork"]);
    await app.close();
  });

  it("nome já usado (sem diferenciar maiúsculas) → 409 que ensina o --name", async () => {
    const { stub } = deps([{ id: "1", name: "App", repoPath: "/x/App" }]);
    const app = buildServer(stub);
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { repoPath: repo("app") },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("--name");
    await app.close();
  });

  it("nome com espaço ou parecido com UUID é recusado", async () => {
    const { stub, created } = deps();
    const app = buildServer(stub);
    for (const name of ["meu app", "c8f36cfa-89e2-4851-ad7e-84d8413f9018"]) {
      const response = await app.inject({
        method: "POST",
        url: "/projects",
        payload: { repoPath: repo("zzz"), name },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(created).toHaveLength(0);
    await app.close();
  });
});
