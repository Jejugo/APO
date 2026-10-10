// Execução supervisionada de um CLI de agente (M3.0a — `ProcessSupervisor`
// mínimo). Concentra em um lugar o que os harnesses repetiam:
// - process group + kill da árvore (execa `killDescendants`), timeout e cancelamento;
// - stdin fechado (os dois CLIs travam esperando EOF sem isso — spikes M0.9/M0.10);
// - environment **só** com o que veio em `env` (`extendEnv: false`), nunca o
//   `process.env` do daemon (M3.0b, seção 6.3 do TECHNICAL_PLAN.md);
// - log por attempt em `logPath` (stdout + stderr), para depurar depois.
//
// Detecção de `stalled` (sem saída nem mudança em disco por N minutos) fica
// para o `ProcessSupervisor` completo do M2.

import { appendFile, mkdir } from "node:fs/promises";
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
}

export interface SupervisedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  failed: boolean;
  timedOut: boolean;
  canceled: boolean;
}

export async function runSupervisedProcess(
  input: SupervisedProcessInput,
): Promise<SupervisedProcessResult> {
  const result = await execa(input.file, input.args, {
    cwd: input.cwd,
    env: input.env,
    extendEnv: false,
    stdin: "ignore",
    timeout: input.timeoutMs,
    cancelSignal: input.signal,
    killDescendants: true,
    reject: false,
  });

  await writeAttemptLog(input, result.stdout, result.stderr, result.exitCode);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    failed: result.failed,
    timedOut: result.timedOut,
    canceled: result.isCanceled,
  };
}

async function writeAttemptLog(
  input: SupervisedProcessInput,
  stdout: string,
  stderr: string,
  exitCode: number | undefined,
): Promise<void> {
  try {
    await mkdir(dirname(input.logPath), { recursive: true });
    const header = `# ${new Date().toISOString()} ${input.file} (cwd: ${input.cwd}) exit=${exitCode ?? "?"}\n`;
    await appendFile(
      input.logPath,
      `${header}## stdout\n${stdout}\n## stderr\n${stderr}\n`,
      "utf8",
    );
  } catch {
    // Log é auxiliar: falhar ao gravar não pode derrubar a execução.
  }
}
