import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { GlobalConfigSchema, expandHome, globalConfigPath, loadConfig } from "@apo/config";

export function resolveSocketPath(): string {
  const config = loadConfig(globalConfigPath(), GlobalConfigSchema);
  return expandHome(config.socketPath ?? "~/.apo/apo.sock");
}

export class DaemonUnavailableError extends Error {
  constructor() {
    super("apo daemon não está rodando. Rode 'apo daemon start' primeiro.");
    this.name = "DaemonUnavailableError";
  }
}

export interface DaemonRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

/** Cliente HTTP mínimo sobre o Unix socket do daemon (TECHNICAL_PLAN.md seção 2). */
export function daemonRequest<T>(path: string, options: DaemonRequestOptions = {}): Promise<T> {
  const socketPath = resolveSocketPath();
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: options.method ?? "GET",
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
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
            reject(new Error(`daemon respondeu ${status}: ${text}`));
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
  const socketPath = resolveSocketPath();
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (res) => resolve(res));
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
