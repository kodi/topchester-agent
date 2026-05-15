import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { formatProjectInstructions, isProjectInstructionPath, resolveProjectInstructions } from "../instructions.js";
import { type ProjectInstructionToolResult, type ToolContext } from "./types.js";

export interface ResolveToolProjectInstructionsOptions {
  targetPath: string;
  targetIsDirectory?: boolean;
  skipWhenTargetIsInstructionFile?: boolean;
}

export async function resolveToolProjectInstructions(
  context: ToolContext,
  options: ResolveToolProjectInstructionsOptions
): Promise<ProjectInstructionToolResult | undefined> {
  if (!context.projectInstructions) {
    return undefined;
  }

  if (options.skipWhenTargetIsInstructionFile && isProjectInstructionPath(context.workspaceRoot, options.targetPath)) {
    return undefined;
  }

  const instructions = await resolveProjectInstructions(context.workspaceRoot, {
    targetPath: options.targetPath,
    targetIsDirectory: options.targetIsDirectory,
    logger: context.logger,
  });
  const newSources = instructions.sources.filter(
    (source) => !context.projectInstructions!.shownSourceKeys.has(source.relativePath)
  );

  if (newSources.length === 0) {
    return undefined;
  }

  for (const source of newSources) {
    context.projectInstructions.shownSourceKeys.add(source.relativePath);
  }

  return {
    sources: newSources.map((source) => ({
      relativePath: source.relativePath,
      scopePath: source.scopePath,
      bytes: source.bytes,
      truncated: source.truncated,
    })),
    formatted: formatProjectInstructions(newSources),
  };
}

export function appendProjectInstructionsToToolContent(
  content: string,
  instructions: ProjectInstructionToolResult | undefined
): string {
  if (!instructions) {
    return content;
  }

  return [
    content,
    "",
    "New project instructions for this path were loaded. Apply them before deciding the next step.",
    instructions.formatted,
  ].join("\n");
}

export function formatProjectInstructionRetryContent(
  toolName: string,
  targetPath: string,
  instructions: ProjectInstructionToolResult
): string {
  const sourceList = instructions.sources.map((source) => source.relativePath).join(", ");

  return [
    `${toolName} did not change ${targetPath}.`,
    `New project instructions apply here: ${sourceList}.`,
    "Read and apply these instructions, then retry the tool call if the change is still appropriate.",
    "",
    instructions.formatted,
  ].join("\n");
}

export function formatWorkspaceRelativeToolPath(workspaceRoot: string, path: string): string {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  return relativePath || ".";
}

export async function isWorkspacePathDirectory(workspaceRoot: string, path: string): Promise<boolean> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return false;
  }

  try {
    return (await stat(resolvedPath)).isDirectory();
  } catch {
    return false;
  }
}

export function isDirectInstructionFileRead(path: string): boolean {
  const name = basename(path);

  return name === "AGENTS.md" || name === "AGENTS.override.md";
}
