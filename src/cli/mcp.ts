import { loadTopchesterConfig, type ConfigLoadOptions, type TopchesterConfig } from "../config/index.js";

export interface McpListEntry {
  name: string;
  type: "stdio";
  enabled: boolean;
  command: string;
  args: string[];
  env: string[];
  enabledTools: string[] | null;
  timeoutMs: number | null;
}

export function collectMcpList(options: ConfigLoadOptions): McpListEntry[] {
  return toMcpListEntries(loadTopchesterConfig(options));
}

export function toMcpListEntries(config: TopchesterConfig): McpListEntry[] {
  return Object.entries(config.mcp ?? {}).map(([name, server]) => ({
    name,
    type: server.type,
    enabled: server.enabled !== false,
    command: server.command,
    args: server.args,
    env: Object.keys(server.env).sort(),
    enabledTools: server.enabledTools ?? null,
    timeoutMs: server.timeoutMs ?? null,
  }));
}

export function formatMcpList(entries: readonly McpListEntry[]): string[] {
  if (entries.length === 0) {
    return ["No MCP servers configured."];
  }

  return [
    "MCP servers",
    "",
    ...entries.flatMap((entry, index) => [
      ...(index > 0 ? [""] : []),
      `${entry.name}:`,
      `  status: ${entry.enabled ? "enabled" : "disabled"}`,
      `  transport: ${entry.type}`,
      `  command: ${formatCommand(entry.command, entry.args)}`,
      `  environment: ${entry.env.length > 0 ? entry.env.join(", ") : "none"}`,
      `  tools: ${entry.enabledTools ? entry.enabledTools.join(", ") : "all"}`,
      `  timeout: ${entry.timeoutMs === null ? "default" : `${entry.timeoutMs}ms`}`,
    ]),
  ];
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : JSON.stringify(value);
}
