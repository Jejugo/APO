import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSupervisedProcess } from "./run-process.js";

// Tempos com folga: sob `pnpm check` (todos os pacotes em paralelo) só subir o
// `sh` pode levar centenas de ms. Os processos "ativos" duram 2 s, mais que a
// tolerância de 1,5 s — sem as atividades no meio, seriam dados como travados.
describe("runSupervisedProcess — stall (M2.3)", { timeout: 20_000 }, () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function cwd(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "apo-stall-"));
    dirs.push(dir);
    return dir;
  }

  const base = (dir: string) => ({
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    logPath: join(dir, "..", `${Date.now()}-stall.log`),
  });

  it("processo mudo e sem escrita em disco é morto como stalled", async () => {
    const dir = await cwd();
    const result = await runSupervisedProcess({
      ...base(dir),
      file: "sleep",
      args: ["5"],
      stallTimeoutMs: 300,
    });
    expect(result.stalled).toBe(true);
    expect(result.canceled).toBe(false);
  });

  it("saída periódica mantém o processo vivo", async () => {
    const dir = await cwd();
    const result = await runSupervisedProcess({
      ...base(dir),
      file: "sh",
      args: ["-c", "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.25; done"],
      stallTimeoutMs: 1_500,
    });
    expect(result.stalled).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("escrita em disco sem saída também conta como atividade", async () => {
    const dir = await cwd();
    const result = await runSupervisedProcess({
      ...base(dir),
      file: "sh",
      args: ["-c", "for i in 1 2 3 4 5 6 7 8; do echo $i > f.txt; sleep 0.25; done"],
      stallTimeoutMs: 1_500,
    });
    expect(result.stalled).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("cancelamento externo não é reportado como stalled", async () => {
    const dir = await cwd();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runSupervisedProcess({
      ...base(dir),
      signal: controller.signal,
      file: "sleep",
      args: ["5"],
      stallTimeoutMs: 5_000,
    });
    expect(result.canceled).toBe(true);
    expect(result.stalled).toBe(false);
  });
});
