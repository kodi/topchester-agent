import { bashTool } from "./bash.js";
import { applyPatchTool } from "./apply-patch.js";
import { editFileTool } from "./edit-file.js";
import { finishTaskTool } from "./finish-task.js";
import { findFileTool } from "./find-file.js";
import { gitAddTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from "./git.js";
import { grepTool } from "./grep.js";
import { inspectCommandTool } from "./inspect-command.js";
import { listFilesTool } from "./list-files.js";
import { planTodoTool } from "./plan-todo.js";
import { readFileTool } from "./read-file.js";
import { runValidatorTool } from "./run-validator.js";
import { skillViewTool, skillsListTool } from "./skills.js";
import { taskTool } from "./task.js";
import { type ToolCallForDefinition, type ToolResultForDefinition } from "./types.js";
import { webFetchTool } from "./web-fetch.js";
import { writeFileTool } from "./write-file.js";

export const toolRegistry = {
  [taskTool.name]: taskTool,
  [planTodoTool.name]: planTodoTool,
  [readFileTool.name]: readFileTool,
  [listFilesTool.name]: listFilesTool,
  [grepTool.name]: grepTool,
  [findFileTool.name]: findFileTool,
  [applyPatchTool.name]: applyPatchTool,
  [editFileTool.name]: editFileTool,
  [writeFileTool.name]: writeFileTool,
  [gitStatusTool.name]: gitStatusTool,
  [gitDiffTool.name]: gitDiffTool,
  [gitLogTool.name]: gitLogTool,
  [gitAddTool.name]: gitAddTool,
  [gitCommitTool.name]: gitCommitTool,
  [inspectCommandTool.name]: inspectCommandTool,
  [runValidatorTool.name]: runValidatorTool,
  [bashTool.name]: bashTool,
  [webFetchTool.name]: webFetchTool,
  [finishTaskTool.name]: finishTaskTool,
  [skillsListTool.name]: skillsListTool,
  [skillViewTool.name]: skillViewTool,
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

export function getToolPromptLines(filter?: (toolName: ToolName) => boolean): string[] {
  return getToolDefinitionsForPermissions(filter).map((tool) => tool.prompt);
}

export function getToolDefinitionsForPermissions(filter?: (toolName: ToolName) => boolean): RegisteredTool[] {
  return Object.entries(toolRegistry)
    .filter(([name]) => filter?.(name as ToolName) ?? true)
    .map(([, tool]) => tool);
}

export function isParallelSafeToolName(name: string): name is ToolName {
  if (!isToolName(name)) {
    return false;
  }

  const definition = toolRegistry[name];

  return Boolean(definition.parallelSafe && !definition.mutatesWorkspace && !definition.requiresExclusiveWorkspace);
}
