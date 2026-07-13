import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { type McpConnectedServer, type McpManagerOptions, type McpServerStatus } from "./types.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_STDERR_SUMMARY_BYTES = 4096;

export class McpManager {
  readonly #workspaceRoot: string;
  readonly #config: McpManagerOptions["config"];
  readonly #logger: McpManagerOptions["logger"];
  readonly #signal: AbortSignal | undefined;
  readonly #servers = new Map<string, McpConnectedServer>();
  readonly #statuses = new Map<string, McpServerStatus>();

  constructor(options: McpManagerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#signal = options.signal;
  }

  async connectAll(): Promise<void> {
    for (const [serverName, config] of Object.entries(this.#config ?? {})) {
      if (!config.enabled) {
        this.#statuses.set(serverName, {
          state: "disabled",
          serverName,
          message: "MCP server is disabled in config.",
        });
        continue;
      }

      await this.#connectServer(serverName, config);
    }
  }

  statuses(): McpServerStatus[] {
    return [...this.#statuses.values()];
  }

  connectedServers(): McpConnectedServer[] {
    return [...this.#servers.values()];
  }

  tools(): Array<{ serverName: string; tool: McpConnectedServer["tools"][number] }> {
    return this.connectedServers().flatMap((server) =>
      server.tools.map((tool) => ({
        serverName: server.serverName,
        tool,
      }))
    );
  }

  getServer(serverName: string): McpConnectedServer | undefined {
    return this.#servers.get(serverName);
  }

  async close(): Promise<void> {
    const servers = this.connectedServers();
    this.#servers.clear();

    await Promise.all(
      servers.map(async (server) => {
        try {
          await server.client.close();
        } catch (error) {
          this.#logger?.warn({ serverName: server.serverName, error: formatError(error) }, "MCP server close failed");
        }
      })
    );
  }

  async #connectServer(serverName: string, config: NonNullable<McpManagerOptions["config"]>[string]): Promise<void> {
    const stderr = createStderrCapture();
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: this.#workspaceRoot,
      env: mergeProcessEnv(config.env),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
    });

    const client = new Client({
      name: "topchester",
      version: "0.42.0",
    });
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const requestOptions = createRequestOptions(timeoutMs, this.#signal);

    try {
      await client.connect(transport, requestOptions);
      const listed = await client.listTools(undefined, requestOptions);
      const connected: McpConnectedServer = {
        serverName,
        config,
        client,
        transport,
        tools: listed.tools,
        stderr: () => stderr.read(),
      };

      this.#servers.set(serverName, connected);
      this.#statuses.set(serverName, {
        state: "connected",
        serverName,
        toolCount: listed.tools.length,
      });
      this.#logger?.debug({ serverName, toolCount: listed.tools.length }, "MCP stdio server connected");
    } catch (error) {
      await closeAfterFailure(client, transport);
      const status: McpServerStatus = {
        state: "failed",
        serverName,
        error: formatError(error),
        ...(stderr.read() ? { stderr: stderr.read() } : {}),
      };
      this.#statuses.set(serverName, status);
      this.#logger?.warn(
        {
          serverName,
          error: status.error,
          ...(status.stderr ? { stderr: status.stderr } : {}),
        },
        "MCP stdio server failed"
      );
    }
  }
}

function createRequestOptions(timeout: number, signal: AbortSignal | undefined): RequestOptions {
  return {
    timeout,
    maxTotalTimeout: timeout,
    ...(signal ? { signal } : {}),
  };
}

function mergeProcessEnv(configEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  return { ...env, ...configEnv };
}

function createStderrCapture(): { append(chunk: Buffer | string): void; read(): string | undefined } {
  let value = "";

  return {
    append(chunk) {
      value = `${value}${chunk.toString("utf8")}`;

      if (value.length > MAX_STDERR_SUMMARY_BYTES) {
        value = value.slice(value.length - MAX_STDERR_SUMMARY_BYTES);
      }
    },
    read() {
      const trimmed = value.trim();

      return trimmed.length > 0 ? trimmed : undefined;
    },
  };
}

async function closeAfterFailure(client: Client, transport: StdioClientTransport): Promise<void> {
  await Promise.allSettled([client.close(), transport.close()]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
