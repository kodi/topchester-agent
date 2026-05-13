import { editFileTool } from "./edit-file.js";
import { findFileTool } from "./find-file.js";
import { grepTool } from "./grep.js";
import { inspectCommandTool } from "./inspect-command.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { type ToolCallForDefinition, type ToolResultForDefinition } from "./types.js";

export const toolRegistry = {
  [readFileTool.name]: readFileTool,
  [listFilesTool.name]: listFilesTool,
  [grepTool.name]: grepTool,
  [findFileTool.name]: findFileTool,
  [editFileTool.name]: editFileTool,
  [inspectCommandTool.name]: inspectCommandTool,
} as const;

export type ToolName = keyof typeof toolRegistry;
export type RegisteredTool = (typeof toolRegistry)[ToolName];
export type ToolCall = ToolCallForDefinition<RegisteredTool>;
export type ToolResult = ToolResultForDefinition<RegisteredTool>;

export function isToolName(name: string): name is ToolName {
  return name in toolRegistry;
}

export function getToolDefinition<Name extends ToolName>(name: Name): (typeof toolRegistry)[Name] {
  return toolRegistry[name];
}

export function getToolPromptLines(): string[] {
  return Object.values(toolRegistry).map((tool) => tool.prompt);
}
