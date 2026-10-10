import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ROLES, GENERIC_ROLE_ID, loadRoleRegistry } from "./roles.js";

describe("loadRoleRegistry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "apo-roles-"));
    dirs.push(dir);
    return dir;
  }

  it("sem .apo/roles devolve só os defaults, incluindo generic", () => {
    const registry = loadRoleRegistry(repo());
    expect([...registry.keys()]).toEqual(DEFAULT_ROLES.map((role) => role.id));
    expect(registry.has(GENERIC_ROLE_ID)).toBe(true);
  });

  it("YAML do Project adiciona roles e substitui defaults pelo id", () => {
    const repoPath = repo();
    mkdirSync(join(repoPath, ".apo", "roles"), { recursive: true });
    writeFileSync(
      join(repoPath, ".apo", "roles", "backend.yaml"),
      "id: backend-developer\nname: Backend da casa\nsystemPrompt: Use Fastify.\n",
    );
    writeFileSync(
      join(repoPath, ".apo", "roles", "dba.yml"),
      "id: dba\nname: DBA\nsystemPrompt: Cuide das migrations.\nexecutionPreference:\n  mode: preferred\n  provider: openai\n",
    );
    const registry = loadRoleRegistry(repoPath);
    expect(registry.get("backend-developer")?.systemPrompt).toBe("Use Fastify.");
    expect(registry.get("dba")?.executionPreference).toEqual({
      mode: "preferred",
      provider: "openai",
    });
  });

  it("YAML inválido falha alto em vez de ser ignorado", () => {
    const repoPath = repo();
    mkdirSync(join(repoPath, ".apo", "roles"), { recursive: true });
    writeFileSync(join(repoPath, ".apo", "roles", "ruim.yaml"), "id: Com Espaço\nname: x\n");
    expect(() => loadRoleRegistry(repoPath)).toThrow();
  });
});
