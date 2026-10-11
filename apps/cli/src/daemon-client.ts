import { readFileSync } from "node:fs";
import { type RequestOptions, request } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { GlobalConfigSchema, apoHome, expandHome, globalConfigPath, loadConfig } from "@apo/config";

export function resolveSocketPath(): string {
  const config = loadConfig(globalConfigPath(), GlobalConfigSchema);
  return expandHome(config.socketPath ?? "~/.apo/apo.sock");
}

/**
 * M6.7 — daemon remoto (ex.: na VM, pelo Tailscale): `APO_URL=http://100.x.y.z:7400`
 * e o token em `APO_TOKEN` (ou `APO_REMOTE_TOKEN` em ~/.apo/secrets.env).
 * Sem `APO_URL`, fala com o daemon local pelo socket Unix.
 */
function remoteToken(): string | undefined {
  if (process.env.APO_TOKEN) return process.env.APO_TOKEN;
  try {
    const line = readFileSync(join(apoHome(), "secrets.env"), "utf8")
      .split("\n")
      .find((entry) => entry.trim().startsWith("APO_REMOTE_TOKEN="));
    return line
      ?.split("=")
      .slice(1)
      .join("=")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  } catch {
    return undefined;
  }
}

function connection(path: string, method: string): RequestOptions {
  const remote = process.env.APO_URL;
  if (!remote) {
    return { socketPath: resolveSocketPath(), path, method };
  }
  const url = new URL(path, remote);
  const token = remoteToken();
  return {
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

export class DaemonUnavailableError extends Error {
  constructor() {
    super("apo daemon não está rodando. Rode 'apo daemon start' primeiro.");
    this.name = "DaemonUnavailableError";
  }
}

/** Resposta não-2xx do daemon, com o corpo já parseado quando é JSON. */
export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    text: string,
  ) {
    super(`daemon respondeu ${status}: ${text}`);
    this.name = "DaemonHttpError";
  }
}

export interface DaemonRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

/** Cliente HTTP mínimo sobre o Unix socket do daemon (TECHNICAL_PLAN.md seção 2). */
export function daemonRequest<T>(path: string, options: DaemonRequestOptions = {}): Promise<T> {
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const base = connection(path, options.method ?? "GET");

  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...base,
        headers: {
          ...(base.headers as Record<string, string> | undefined),
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
          } else {
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            reject(new DaemonHttpError(status, body, text));
          }
        });
      },
    );

    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        reject(new DaemonUnavailableError());
      } else {
        reject(error);
      }
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/** Para respostas que não são um JSON único (ex.: SSE de `apo logs -f`). */
export function daemonStream(path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(connection(path, "GET"), (res) => resolve(res));
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        reject(new DaemonUnavailableError());
      } else {
        reject(error);
      }
    });
    req.end();
  });
}
