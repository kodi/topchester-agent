import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolErrorResult, type ToolResult } from "../tools/types.js";
import { type McpConnectedServer } from "./types.js";

export const DEFAULT_MCP_MAX_EXPOSED_TOOLS = 64;

export interface McpToolConversionResult {
  definitions: Array<ToolDefinition<string, Record<string, unknown>>>;
  errors: string[];
}

export function createMcpToolDefinitions(
  servers: readonly McpConnectedServer[],
  options: { maxExposedTools?: number } = {}
): McpToolConversionResult {
  const definitions: Array<ToolDefinition<string, Record<string, unknown>>> = [];
  const errors: string[] = [];
  const usedNames = new Map<string, string>();
  const maxExposedTools = options.maxExposedTools ?? DEFAULT_MCP_MAX_EXPOSED_TOOLS;

  for (const server of servers) {
    const allowedTools = server.config.enabledTools ? new Set(server.config.enabledTools) : undefined;
    const tools = allowedTools ? server.tools.filter((tool) => allowedTools.has(tool.name)) : server.tools;

    if (!allowedTools && tools.length > maxExposedTools) {
      errors.push(
        `MCP server "${server.serverName}" exposes ${tools.length} tools, above the V0 cap of ${maxExposedTools}; configure enabledTools to expose a smaller set.`
      );
      continue;
    }

    if (allowedTools) {
      for (const toolName of allowedTools) {
        if (!server.tools.some((tool) => tool.name === toolName)) {
          errors.push(`MCP server "${server.serverName}" enabledTools references missing tool "${toolName}".`);
        }
      }
    }

    for (const tool of tools) {
      const modelName = toMcpModelToolName(server.serverName, tool.name);
      const existing = usedNames.get(modelName);

      if (existing) {
        errors.push(
          `MCP tool name collision for "${modelName}" between ${existing} and ${server.serverName}/${tool.name}.`
        );
        continue;
      }

      usedNames.set(modelName, `${server.serverName}/${tool.name}`);
      definitions.push(createMcpToolDefinition(server, tool, modelName));
    }
  }

  return { definitions, errors };
}

export function toMcpModelToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(toolName)}`;
}

function createMcpToolDefinition(
  server: McpConnectedServer,
  tool: Tool,
  modelName: string
): ToolDefinition<string, Record<string, unknown>> {
  return defineTool({
    name: modelName,
    description: tool.description ?? `MCP tool ${tool.name} from ${server.serverName}.`,
    prompt: `${modelName}: ${tool.description ?? `MCP tool ${tool.name} from ${server.serverName}.`}`,
    argsSchema: z.record(z.string(), z.unknown()),
    parallelSafe: Boolean(tool.annotations?.readOnlyHint),
    async execute(_context, args) {
      try {
        const result = await server.client.callTool(
          {
            name: tool.name,
            arguments: args,
          },
          undefined,
          {
            timeout: server.config.timeoutMs,
            maxTotalTimeout: server.config.timeoutMs,
          }
        );

        if ("isError" in result && result.isError) {
          return {
            tool: modelName,
            content: formatMcpResultContent(result),
            error: `MCP tool "${tool.name}" returned an error.`,
            warning: `MCP tool "${tool.name}" returned an error.`,
          } satisfies ToolErrorResult;
        }

        return {
          tool: modelName,
          content: formatMcpResultContent(result),
        } satisfies ToolResult;
      } catch (error) {
        return {
          tool: modelName,
          content: `MCP tool ${modelName} failed: ${formatError(error)}`,
          error: formatError(error),
          warning: formatError(error),
        } satisfies ToolErrorResult;
      }
    },
  });
}

function formatMcpResultContent(result: unknown): string {
  if (!isMcpContentResult(result)) {
    return JSON.stringify(result);
  }

  const textParts = result.content.filter((part) => part.type === "text").map((part) => part.text);
  const unsupportedParts = result.content.filter((part) => part.type !== "text");
  const content = textParts.join("\n").trim();
  const unsupportedSummary =
    unsupportedParts.length > 0
      ? `Unsupported MCP result parts omitted: ${unsupportedParts.map((part) => part.type).join(", ")}.`
      : "";

  return [content, unsupportedSummary].filter((part) => part.length > 0).join("\n");
}

function isMcpContentResult(result: unknown): result is {
  content: Array<{ type: string; text?: string }>;
} {
  return typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content);
}

function sanitizeNamePart(value: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[^\w]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();

  return sanitized.length > 0 ? sanitized : "tool";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
