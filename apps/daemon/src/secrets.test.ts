import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecretsFile } from "./secrets.js";

describe("loadSecretsFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function file(content: string, mode = 0o600): string {
    const dir = mkdtempSync(join(tmpdir(), "apo-secrets-"));
    dirs.push(dir);
    const path = join(dir, "secrets.env");
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it("carrega KEY=VALUE, ignora comentários e não sobrescreve o ambiente", () => {
    const env: NodeJS.ProcessEnv = { JA_EXISTE: "do-ambiente" };
    const result = loadSecretsFile(
      file("# comentário\nA=1\nexport B='dois'\nJA_EXISTE=do-arquivo\n"),
      env,
    );
    expect(result).toEqual({ loaded: ["A", "B"] });
    expect(env).toMatchObject({ A: "1", B: "dois", JA_EXISTE: "do-ambiente" });
  });

  it("arquivo ausente não é erro; permissão larga gera aviso", () => {
    expect(loadSecretsFile("/nao/existe/secrets.env", {})).toEqual({ loaded: [] });
    expect(loadSecretsFile(file("A=1\n", 0o644), {}).warning).toContain("chmod 600");
  });
});
