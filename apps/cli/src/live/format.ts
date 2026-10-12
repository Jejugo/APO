// Formata as linhas do log de um attempt (stream-json do Claude Code, JSONL do
// Codex, JSON final do agy) em linhas curtas e legíveis para `apo task tail`.
// Linha que não interessa → []. Nunca lança.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const c = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};

const MAX = 220;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Texto sem os códigos de cor (para medir a largura visível). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function oneLine(text: unknown, max = MAX): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type Json = Record<string, unknown>;

/** Caminhos de worktree/runs do APO viram curtos: "src/a.ts", "relatório da Task". */
export function shortPath(path: string): string {
  if (/\/runs\/[^/]+\/result\.json$/.test(path)) return "relatório da Task (result.json)";
  return path.replace(/^.*\/worktrees\/[^/]+\/[^/]+\//, "");
}

function shortenPaths(text: string): string {
  return text.replace(/\/\S*\/worktrees\/[^/\s]+\/[^/\s]+\//g, "");
}

function claudeTool(name: string, input: Json): string {
  const rawPath = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  const path = rawPath ? shortPath(rawPath) : undefined;
  switch (name) {
    case "Bash":
      return c.cyan(`$ ${oneLine(shortenPaths(String(input.command ?? "")))}`);
    case "Read":
      return c.blue(`📖 ${path ?? ""}`);
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return c.green(`✎ ${path ?? ""}${name === "Write" ? " (novo/reescrito)" : ""}`);
    case "Grep":
      return c.blue(`🔍 ${oneLine(input.pattern, 80)}${input.path ? ` em ${input.path}` : ""}`);
    case "Glob":
      return c.blue(`🔍 ${oneLine(input.pattern, 80)}`);
    case "TodoWrite": {
      const todos = (input.todos as Array<{ content?: string; status?: string }> | undefined) ?? [];
      const doing = todos.find((todo) => todo.status === "in_progress");
      return c.magenta(
        `☑ ${todos.filter((todo) => todo.status === "completed").length}/${todos.length} tarefas${doing ? ` — agora: ${oneLine(doing.content, 100)}` : ""}`,
      );
    }
    case "StructuredOutput":
      return c.magenta("📦 resposta estruturada enviada");
    case "WebFetch":
    case "WebSearch":
      return c.blue(`🌐 ${oneLine(input.url ?? input.query, 120)}`);
    default:
      return c.dim(`🔧 ${name} ${oneLine(JSON.stringify(input), 120)}`);
  }
}

function formatClaude(event: Json): string[] {
  const type = event.type;
  if (type === "system") {
    return event.subtype === "init"
      ? [c.dim(`▶ sessão Claude Code iniciada${event.model ? ` (${event.model})` : ""}`)]
      : [];
  }
  if (type === "assistant" || type === "user") {
    const content = ((event.message as Json | undefined)?.content as Json[] | undefined) ?? [];
    const out: string[] = [];
    for (const item of content) {
      if (item.type === "text" && item.text) out.push(`💬 ${oneLine(item.text, 400)}`);
      else if (item.type === "thinking" && item.thinking)
        out.push(c.dim(`🧠 ${oneLine(item.thinking, 160)}`));
      else if (item.type === "tool_use")
        out.push(claudeTool(String(item.name), (item.input as Json) ?? {}));
      else if (item.type === "tool_result" && item.is_error) {
        out.push(
          c.red(
            `  ✗ ${oneLine(typeof item.content === "string" ? item.content : JSON.stringify(item.content), 160)}`,
          ),
        );
      }
    }
    return out;
  }
  if (type === "result") {
    const cost =
      typeof event.total_cost_usd === "number" ? ` · US$ ${event.total_cost_usd.toFixed(3)}` : "";
    const seconds =
      typeof event.duration_ms === "number" ? ` · ${Math.round(event.duration_ms / 1000)}s` : "";
    return [
      event.is_error
        ? c.red(`■ terminou com erro: ${oneLine(event.result, 200)}`)
        : c.bold(`■ concluído (${event.num_turns ?? "?"} turnos${seconds}${cost})`),
    ];
  }
  return [];
}

function formatCodex(event: Json): string[] {
  const type = String(event.type ?? "");
  const item = (event.item as Json | undefined) ?? {};
  switch (type) {
    case "thread.started":
      return [c.dim("▶ sessão Codex iniciada")];
    case "item.started":
      return item.type === "command_execution"
        ? [c.cyan(`$ ${oneLine(shortenPaths(String(item.command ?? "")))}`)]
        : [];
    case "item.completed":
      switch (item.type) {
        case "agent_message":
          return [`💬 ${oneLine(item.text, 400)}`];
        case "reasoning":
          return [c.dim(`🧠 ${oneLine(item.text, 160)}`)];
        case "command_execution":
          return typeof item.exit_code === "number" && item.exit_code !== 0
            ? [c.red(`  ✗ exit ${item.exit_code}: ${oneLine(item.aggregated_output, 160)}`)]
            : [];
        case "file_change":
          return ((item.changes as Array<{ path?: string; kind?: string }> | undefined) ?? []).map(
            (change) => c.green(`✎ ${change.path ?? ""}${change.kind ? ` (${change.kind})` : ""}`),
          );
        case "todo_list": {
          const items =
            (item.items as Array<{ text?: string; completed?: boolean }> | undefined) ?? [];
          return [
            c.magenta(`☑ ${items.filter((todo) => todo.completed).length}/${items.length} tarefas`),
          ];
        }
        case "mcp_tool_call":
        case "web_search":
          return [c.blue(`🔧 ${oneLine(item.tool ?? item.query ?? item.type, 120)}`)];
        default:
          return [];
      }
    case "turn.completed": {
      const usage = (event.usage as Json | undefined) ?? {};
      return [
        c.bold(
          `■ concluído (${usage.input_tokens ?? "?"} tokens in / ${usage.output_tokens ?? "?"} out)`,
        ),
      ];
    }
    case "turn.failed":
      return [
        c.red(
          `■ falhou: ${oneLine((event.error as Json | undefined)?.message ?? JSON.stringify(event), 200)}`,
        ),
      ];
    case "error":
      return [c.red(`✗ ${oneLine(event.message, 200)}`)];
    default:
      return [];
  }
}

/** Uma linha crua do log → 0..n linhas formatadas. */
export function formatAgentLine(raw: string): string[] {
  const line = raw.trimEnd();
  if (!line) return [];
  if (line.startsWith("# ")) {
    const end = /exit=(\S+)/.exec(line);
    return [c.dim(end ? `— processo terminou (exit ${end[1]}) —` : "— processo iniciado —")];
  }
  if (line.startsWith("[stderr] ")) {
    const text = line.slice(9).trim();
    return text ? [c.dim(`stderr: ${oneLine(text, 160)}`)] : [];
  }
  if (!line.startsWith("{")) return [c.dim(oneLine(line, 160))];
  let event: Json;
  try {
    event = JSON.parse(line) as Json;
  } catch {
    return [];
  }
  // agy: um JSON final {status, response}.
  if (typeof event.status === "string" && "response" in event && !("type" in event)) {
    return [
      ...(event.response ? [`💬 ${oneLine(event.response, 400)}`] : []),
      event.status === "SUCCESS"
        ? c.bold("■ concluído")
        : c.red(`■ ${event.status}: ${oneLine(event.error, 200)}`),
    ];
  }
  const type = String(event.type ?? "");
  if (type.includes(".") || type === "error") return formatCodex(event);
  return formatClaude(event);
}
