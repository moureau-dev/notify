import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class CliError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "CliError";
    this.status = status;
  }
}

export interface CliConfig {
  url: string;
  token?: string;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return process.env.NOTIFY_CONFIG ?? join(base, "notify", "config.json");
}

export function loadCliConfig(): CliConfig {
  const fallback: CliConfig = {
    url: process.env.NOTIFY_URL ?? "",
    token: process.env.NOTIFY_TOKEN,
  };

  try {
    const stored = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<CliConfig>;
    return {
      url: fallback.url || stored.url || "http://127.0.0.1:8787",
      token: fallback.token ?? stored.token,
    };
  } catch {
    return {
      url: fallback.url || "http://127.0.0.1:8787",
      token: fallback.token,
    };
  }
}

export function saveCliConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Streamable HTTP may answer with SSE frames.
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      return JSON.parse(data);
    } catch {
      // Try the next frame.
    }
  }

  return null;
}

export class NotifyClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async mcpTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    } catch (error) {
      throw new CliError(
        `Could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const parsed = parseMcpBody(text) as { error?: { message?: string } } | null;
      throw new CliError(parsed?.error?.message ?? "MCP tools/list failed", response.status);
    }

    const parsed = parseMcpBody(text) as { result?: { tools?: unknown } } | null;
    const tools = parsed?.result?.tools;
    if (!Array.isArray(tools)) throw new CliError("MCP tools/list did not return tools");

    return tools as Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(
        `Could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const payload = parsed as { error?: { message?: string } } | null;
      const message = payload?.error?.message ?? (typeof parsed === "string" ? parsed : response.statusText);
      throw new CliError(message || "Request failed", response.status);
    }

    return parsed as T;
  }
}
