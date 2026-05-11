import { getToolDefinition, type ToolCall, type ToolResult } from "./registry.js";
import { type ToolDefinition, type ToolContext } from "./types.js";
import { type Logger } from "pino";

export interface ExecuteToolCallOptions {
  pathEnv?: string;
  logger?: Logger;
}

type RuntimeToolDefinition = ToolDefinition<string, unknown, ToolResult>;

export async function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions = {}
): Promise<ToolResult> {
  const definition = getToolDefinition(call.tool) as RuntimeToolDefinition;
  const startedAt = Date.now();
  const context: ToolContext = {
    workspaceRoot,
    pathEnv: options.pathEnv,
    logger: options.logger,
  };

  options.logger?.debug({ event: "tool_call", tool: call.tool, args: call.args }, "tool call");

  try {
    const result = await definition.execute(context, call.args);
    const durationMs = Date.now() - startedAt;

    options.logger?.debug(
      {
        event: "tool_result",
        tool: result.tool,
        path: result.path,
        command: result.command,
        warning: result.warning,
        durationMs,
        contentLength: result.content.length,
      },
      "tool result"
    );
    options.logger?.trace(
      {
        event: "tool_result_content",
        tool: result.tool,
        path: result.path,
        content: result.content,
      },
      "tool result content"
    );

    return result;
  } catch (error) {
    options.logger?.error(
      {
        event: "tool_error",
        tool: call.tool,
        durationMs: Date.now() - startedAt,
        err: error,
      },
      "tool failed"
    );
    throw error;
  }
}
