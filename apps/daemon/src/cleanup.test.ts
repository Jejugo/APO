import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@apo/observability";
import { afterEach, describe, expect, it } from "vitest";
import { isOrphanWorker, killOrphanWorkers } from "./cleanup.js";

describe("isOrphanWorker (M6.8) — só mata o que é certamente um worker do APO", () => {
  const root = "/home/apo/.apo/worktrees";
  const base = { ppid: 1, command: "/home/apo/.local/bin/claude -p ...", cwd: `${root}/f1/t1` };

  it("órfão + comando de agente + cwd nas worktrees → sim", () => {
    expect(isOrphanWorker(base, root)).toBe(true);
    expect(isOrphanWorker({ ...base, command: "codex exec --json x" }, root)).toBe(true);
  });

  it("qualquer condição faltando → não", () => {
    expect(isOrphanWorker({ ...base, ppid: 4242 }, root)).toBe(false); // sessão interativa do usuário
    expect(isOrphanWorker({ ...base, command: "node server.js" }, root)).toBe(false); // PID reaproveitado
    expect(isOrphanWorker({ ...base, cwd: "/home/jeff/projeto" }, root)).toBe(false);
    expect(isOrphanWorker({ ...base, cwd: `${root}-outro/f1` }, root)).toBe(false);
    expect(isOrphanWorker({ ...base, cwd: undefined }, root)).toBe(false);
  });
});

describe("killOrphanWorkers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("encerra o worker órfão, ignora o que não passa na guarda e apaga os pid files", async () => {
    const runs = mkdtempSync(join(tmpdir(), "apo-runs-"));
    dirs.push(runs);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid as number;
    const exited = new Promise((resolve) => child.on("exit", resolve));
    mkdirSync(join(runs, "a1"));
    writeFileSync(join(runs, "a1", "worker.pid"), String(pid));
    mkdirSync(join(runs, "a2"));
    writeFileSync(join(runs, "a2", "worker.pid"), String(process.pid)); // não é worker

    const killed = await killOrphanWorkers(runs, "/wt", createLogger({}), async (candidate) =>
      candidate === pid
        ? { ppid: 1, command: "claude -p x", cwd: "/wt/f1/t1" }
        : { ppid: 99, command: "node vitest", cwd: "/somewhere" },
    );

    expect(killed).toEqual([pid]);
    await exited;
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
