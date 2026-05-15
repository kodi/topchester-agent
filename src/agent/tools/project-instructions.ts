import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  formatProjectInstructions,
  isConfiguredProjectInstructionPath,
  PROJECT_INSTRUCTION_FILENAMES,
  resolveProjectInstructions,
} from "../instructions.js";
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

  if (
    options.skipWhenTargetIsInstructionFile &&
    isConfiguredProjectInstructionPath(context.workspaceRoot, options.targetPath, context.config?.instructions)
  ) {
    return undefined;
  }

  const instructions = await resolveProjectInstructions(context.workspaceRoot, {
    targetPath: options.targetPath,
    targetIsDirectory: options.targetIsDirectory,
    ...context.config?.instructions,
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

export function formatProjectInstructionMutationGuardContent(toolName: string, targetPath: string): string {
  return [
    `${toolName} did not change ${targetPath}.`,
    `${basename(targetPath)} controls future agent behavior.`,
    "Ask explicitly to update project instructions or name the instruction file you want changed, then retry if the edit is still appropriate.",
  ].join("\n");
}

export function hasExplicitProjectInstructionMutationIntent(message: string | undefined, targetPath: string): boolean {
  const normalized = message?.toLowerCase() ?? "";

  if (!normalized) {
    return false;
  }

  const targetName = basename(targetPath).toLowerCase();
  const mentionsInstructionFile =
    PROJECT_INSTRUCTION_FILENAMES.some((name) => normalized.includes(name.toLowerCase())) ||
    normalized.includes(targetName) ||
    normalized.includes("project instruction") ||
    normalized.includes("project instructions");
  const asksForMutation =
    /\b(add|adjust|change|create|edit|modify|rewrite|update|write)\b/u.test(normalized) || /\bmake\b/u.test(normalized);

  return mentionsInstructionFile && asksForMutation;
}

export function isProtectedProjectInstructionTarget(workspaceRoot: string, path: string): boolean {
  return isConfiguredProjectInstructionPath(workspaceRoot, path);
}

export function isProtectedConfiguredProjectInstructionTarget(context: ToolContext, path: string): boolean {
  return isConfiguredProjectInstructionPath(context.workspaceRoot, path, context.config?.instructions);
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
