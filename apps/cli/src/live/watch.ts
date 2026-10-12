// `apo watch <feature>`: painel da Feature que se atualiza sozinho — uma linha
// por Task (estado, agente, tempo) e os últimos eventos. Número + Enter abre o
// agente daquela Task ao vivo (o mesmo do `apo task tail`); `q` volta/sai.

import { daemonRequest } from "../daemon-client.js";
import { c, formatAgentLine, stripAnsi } from "./format.js";
import { followTask } from "./tail.js";

interface Board {
  feature: {
    id: string;
    objective: string;
    status: string;
    fixIteration: number;
    prUrl: string | null;
    createdAt: string;
  };
  tasks: Array<{
    id: string;
    seq: number;
    title: string;
    status: string;
    role: string | null;
    origin: string;
    dependsOn: number[];
    attempt: {
      n: number;
      target: string | null;
      status: string;
      startedAt: string;
      endedAt: string | null;
    } | null;
  }>;
  events: Array<{ type: string; payload: unknown; createdAt: string }>;
}

const REFRESH_MS = 2_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const ICON: Record<string, string> = {
  running: c.yellow("●"),
  ready: c.dim("○"),
  pending: c.dim("◌"),
  retrying: c.yellow("↻"),
  completed: c.green("✓"),
  failed: c.red("✗"),
  cancelled: c.dim("⊘"),
  needs_human: c.red("!"),
};

function elapsed(from: string, to?: string | null): string {
  const seconds = Math.max(
    0,
    Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function summarizeEvent(event: Board["events"][number]): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const time = new Date(event.createdAt).toLocaleTimeString("pt-BR");
  const detail =
    event.type === "quality.completed"
      ? Object.entries((payload.gates ?? {}) as Record<string, string>)
          .map(([gate, status]) => `${gate}=${status}`)
          .join(" ")
      : event.type === "review.completed"
        ? `${payload.findings ?? 0} finding(s), ${payload.blocking ?? 0} bloqueante(s) — ${payload.reviewer ?? ""}`
        : event.type === "attempt.started"
          ? `${payload.target ?? ""} (${payload.role ?? ""})`
          : event.type === "wave.started"
            ? ((payload.tasks as string[] | undefined) ?? []).join(" | ")
            : typeof payload.reason === "string"
              ? payload.reason
              : typeof payload.url === "string"
                ? payload.url
                : "";
  return `${c.dim(time)} ${event.type}${detail ? c.dim(` ${detail}`) : ""}`;
}

function render(board: Board, input: string): string {
  const width = Math.max(60, process.stdout.columns ?? 100);
  const titleWidth = Math.max(20, width - 52);
  const f = board.feature;
  const lines = [
    `${c.bold("APO")} · ${fit(f.objective, width - 40)} ${c.bold(`[${f.status}]`)} ${c.dim(elapsed(f.createdAt))}`,
    c.dim("─".repeat(width)),
    c.dim(`  #  ${"task".padEnd(titleWidth)} ${"agente".padEnd(13)} ${"tempo".padEnd(8)} estado`),
  ];
  for (const task of board.tasks) {
    const agent = task.attempt?.target
      ? `${task.attempt.target}${task.attempt.n > 1 ? ` #${task.attempt.n}` : ""}`
      : "";
    const time = task.attempt ? elapsed(task.attempt.startedAt, task.attempt.endedAt) : "";
    const deps = task.dependsOn.length > 0 ? c.dim(` ← #${task.dependsOn.join(", #")}`) : "";
    lines.push(
      `${ICON[task.status] ?? " "} ${String(task.seq).padStart(2)}  ${fit(task.title, titleWidth)} ${fit(agent, 13)} ${fit(time, 8)} ${task.status}${deps}`,
    );
  }
  lines.push(c.dim("─".repeat(width)), c.dim("últimos eventos:"));
  // Evento longo (ex.: motivo de um plan_change) não pode quebrar o painel.
  // O corte considera os códigos de cor, que não ocupam coluna.
  for (const event of board.events.slice(-8)) {
    const text = ` ${summarizeEvent(event)}`;
    const visible = stripAnsi(text);
    lines.push(visible.length > width ? `${visible.slice(0, width - 1)}…` : text);
  }
  if (f.status === "awaiting_approval") {
    lines.push(
      "",
      c.bold(
        `Feature pronta. Abrir o PR?  apo approve ${f.id}  |  apo reject ${f.id} --reason "..."`,
      ),
    );
  }
  if (f.prUrl) lines.push("", `PR: ${f.prUrl}`);
  lines.push(
    "",
    c.dim(`[número + Enter] ver o agente ao vivo   [q] sair   ${input ? `› ${input}` : ""}`),
  );
  return lines.join("\n");
}

export async function watchFeature(featureId: string): Promise<void> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    // Sem terminal: imprime uma foto e sai (útil em scripts).
    console.log(render(await daemonRequest<Board>(`/features/${featureId}/board`), ""));
    return;
  }

  let mode: "board" | "tail" = "board";
  let input = "";
  let stopTail: (() => void) | undefined;
  let quit: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    quit = resolve;
  });
  let board: Board | undefined;

  const draw = () => {
    if (mode === "board" && board) process.stdout.write(`\x1b[2J\x1b[H${render(board, input)}\n`);
  };
  const refresh = async () => {
    try {
      board = await daemonRequest<Board>(`/features/${featureId}/board`);
      draw();
    } catch (error) {
      process.stdout.write(
        `\x1b[2J\x1b[H${c.red(`erro ao falar com o daemon: ${(error as Error).message}`)}\n`,
      );
    }
  };

  const openTail = async (seq: number) => {
    const task = board?.tasks.find((candidate) => candidate.seq === seq);
    if (!task) return;
    mode = "tail";
    process.stdout.write(
      `\x1b[2J\x1b[H${c.bold(`Task #${task.seq} — ${task.title}`)}  ${c.dim("[q] voltar ao painel")}\n\n`,
    );
    const follow = await followTask(task.id, {
      onAttempt: (attempt) =>
        console.log(
          c.bold(`\n── attempt #${attempt.n} em ${attempt.target ?? "?"} (${attempt.status}) ──`),
        ),
      onLine: (line) => {
        for (const out of formatAgentLine(line)) console.log(out);
      },
      onDone: (status) => console.log(c.bold(`\n── Task ${status}. [q] voltar ──`)),
    });
    stopTail = follow.stop;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  // Um "data" pode trazer várias teclas juntas (digitação rápida, colar):
  // processa caractere por caractere. Setas e outras sequências ESC são ignoradas.
  const handleKey = (key: string) => {
    if (key === "\u0003") return quit(); // Ctrl+C
    if (mode === "tail") {
      if (key === "q" || key === "\u001b") {
        stopTail?.();
        stopTail = undefined;
        mode = "board";
        draw();
      }
      return;
    }
    if (key === "q") return quit();
    if (/^\d$/.test(key)) input += key;
    else if (key === "\u007f") input = input.slice(0, -1);
    else if ((key === "\r" || key === "\n") && input) {
      const seq = Number(input);
      input = "";
      void openTail(seq);
      return;
    }
    draw();
  };
  process.stdin.on("data", (chunk: string) => {
    if (chunk.startsWith("\u001b") && chunk.length > 1) return;
    for (const key of chunk) handleKey(key);
  });

  await refresh();
  const timer = setInterval(() => {
    if (mode === "board") void refresh();
  }, REFRESH_MS);
  await done;
  clearInterval(timer);
  stopTail?.();
  process.stdin.setRawMode(false);
  process.stdin.pause();
  if (board && TERMINAL.has(board.feature.status))
    console.log(`\nFeature ${board.feature.status}.`);
}
