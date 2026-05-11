import { getToolDefinition, type ToolCall, type ToolResult } from "./registry.js";
import { type ToolDefinition, type ToolContext } from "./types.js";

export interface ExecuteToolCallOptions {
  pathEnv?: string;
}

type RuntimeToolDefinition = ToolDefinition<string, unknown, ToolResult>;

export async function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions = {}
): Promise<ToolResult> {
  const definition = getToolDefinition(call.tool) as RuntimeToolDefinition;
  const context: ToolContext = {
    workspaceRoot,
    pathEnv: options.pathEnv,
  };

  return definition.execute(context, call.args);
}
