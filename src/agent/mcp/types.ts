import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Logger } from "pino";
import { type TopchesterConfig } from "../../config/index.js";

export type McpConfig = NonNullable<TopchesterConfig["mcp"]>;
export type McpServerConfig = McpConfig[string];

export type McpServerStatus =
  | {
      state: "disabled";
      serverName: string;
      message: string;
    }
  | {
      state: "connected";
      serverName: string;
      toolCount: number;
    }
  | {
      state: "failed";
      serverName: string;
      error: string;
      stderr?: string;
    };

export interface McpConnectedServer {
  serverName: string;
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  stderr: () => string | undefined;
}

export interface McpManagerOptions {
  workspaceRoot: string;
  config?: McpConfig;
  logger?: Pick<Logger, "debug" | "warn">;
  signal?: AbortSignal;
}
