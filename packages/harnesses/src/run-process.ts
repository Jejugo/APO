// Execução supervisionada de um CLI de agente (M3.0a — `ProcessSupervisor`
// mínimo). Concentra em um lugar o que os harnesses repetiam:
// - process group + kill da árvore (execa `killDescendants`), timeout e cancelamento;
// - stdin fechado (os dois CLIs travam esperando EOF sem isso — spikes M0.9/M0.10);
// - environment **só** com o que veio em `env` (`extendEnv: false`), nunca o
//   `process.env` do daemon (M3.0b, seção 6.3 do TECHNICAL_PLAN.md);
// - log por attempt em `logPath`, gravado ENQUANTO o processo roda (stdout
//   como chega; stderr com prefixo `[stderr] `; linhas de controle com `# `) —
//   é o que o `apo task tail` acompanha ao vivo;
// - `stalled` (M2.3): sem saída e sem mudança em disco (cwd + `activityPaths`)
//   por `stallTimeoutMs` → mata a árvore. Na dúvida, prefere não detectar
//   (falso negativo cai no timeout duro; falso positivo mataria trabalho bom).

import {
  type FSWatcher,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  watch,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { execa } from "execa";

export interface SupervisedProcessInput {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  logPath: string;
  /** Sem atividade por esse tempo → `stalled`. Ausente = desligado. */
  stallTimeoutMs?: number;
  /** Diretórios além do `cwd` cuja escrita conta como atividade. */
  activityPaths?: string[];
  onSpawn?: (pid: number) => void;
}

export interface SupervisedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  failed: boolean;
  timedOut: boolean;
  canceled: boolean;
  stalled: boolean;
}

/** Vigia stdout/stderr e escrita em disco; aborta `stall` sem atividade. */
function startStallWatch(
  input: SupervisedProcessInput,
  stall: AbortController,
): { touch: () => void; stop: () => void } {
  const stallTimeoutMs = input.stallTimeoutMs;
  if (!stallTimeoutMs) return { touch: () => {}, stop: () => {} };

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  const watchers: FSWatcher[] = [];
  for (const path of [input.cwd, ...(input.activityPaths ?? [])]) {
    if (!existsSync(path)) continue;
    try {
      const watcher = watch(path, { recursive: true }, touch);
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Sem watch nesse caminho: só o stdout conta.
    }
  }
  const timer = setInterval(
    () => {
      if (Date.now() - lastActivity >= stallTimeoutMs) stall.abort();
    },
    Math.min(30_000, Math.max(50, Math.floor(stallTimeoutMs / 4))),
  );
  timer.unref();
  return {
    touch,
    stop: () => {
      clearInterval(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

export async function runSupervisedProcess(
  input: SupervisedProcessInput,
): Promise<SupervisedProcessResult> {
  const stall = new AbortController();
  const watch = startStallWatch(input, stall);

  const subprocess = execa(input.file, input.args, {
    cwd: input.cwd,
    env: input.env,
    extendEnv: false,
    stdin: "ignore",
    timeout: input.timeoutMs,
    cancelSignal: AbortSignal.any([input.signal, stall.signal]),
    killDescendants: true,
    reject: false,
  });
  if (subprocess.pid !== undefined) input.onSpawn?.(subprocess.pid);
  const log = openAttemptLog(input);
  subprocess.stdout?.on("data", (chunk: Buffer) => {
    watch.touch();
    log.write(chunk.toString("utf8"));
  });
  let stderrTail = "";
  subprocess.stderr?.on("data", (chunk: Buffer) => {
    watch.touch();
    const text = stderrTail + chunk.toString("utf8");
    const lines = text.split("\n");
    stderrTail = lines.pop() ?? "";
    for (const line of lines) log.write(`[stderr] ${line}\n`);
  });

  let result: Awaited<typeof subprocess>;
  try {
    result = await subprocess;
  } finally {
    watch.stop();
  }
  if (stderrTail) log.write(`[stderr] ${stderrTail}\n`);
  log.close(`# fim ${new Date().toISOString()} exit=${result.exitCode ?? "?"}\n`);

  // Cancelamento externo tem prioridade: quem pediu decide o rumo.
  const stalled = stall.signal.aborted && !input.signal.aborted;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    failed: result.failed,
    timedOut: result.timedOut,
    canceled: result.isCanceled && !stalled,
    stalled,
  };
}

/** Log do attempt aberto em append; falhar ao gravar nunca derruba a execução. */
function openAttemptLog(input: SupervisedProcessInput): {
  write(text: string): void;
  close(footer: string): void;
} {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(input.logPath), { recursive: true });
    fd = openSync(input.logPath, "a");
    writeSync(fd, `# ${new Date().toISOString()} ${input.file} (cwd: ${input.cwd}) início\n`);
  } catch {
    fd = undefined;
  }
  return {
    write(text: string) {
      if (fd === undefined) return;
      try {
        writeSync(fd, text);
      } catch {
        // disco cheio etc.: segue sem log
      }
    },
    close(footer: string) {
      if (fd === undefined) return;
      try {
        writeSync(fd, footer);
        closeSync(fd);
      } catch {
        // idem
      }
      fd = undefined;
    },
  };
}
