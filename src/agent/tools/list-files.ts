import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const listFilesArgsSchema = z.object({
  path: z.string().optional().default("."),
  recursive: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(2_000).optional().default(500),
});

export type ListFilesToolArgs = z.infer<typeof listFilesArgsSchema>;
export type ListFilesToolCall = ToolCall<"list_files", ListFilesToolArgs>;
export type ListFilesToolResult = ToolResult<"list_files">;

interface DirectoryEntry {
  relativePath: string;
  isDirectory: boolean;
}

export const listFilesTool = defineTool({
  name: "list_files",
  description: "List files and directories inside a workspace folder.",
  prompt:
    'list_files: list files and directories inside the workspace; top-level by default, recursive only when requested, with "/" after directory names. To use it, reply with only JSON: {"tool":"list_files","args":{"path":"src","recursive":false,"limit":500}}',
  argsSchema: listFilesArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`dir:${args.path}`],
  execute: (context, args) => listWorkspaceFiles(context.workspaceRoot, args),
});

export async function listWorkspaceFiles(workspaceRoot: string, args: ListFilesToolArgs): Promise<ListFilesToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path);
  const info = await stat(scopedPath.path);

  if (!info.isDirectory()) {
    throw new Error(`list_files can only list directories inside the workspace: ${args.path}`);
  }

  const entries = args.recursive
    ? await collectRecursiveEntries(scopedPath.workspaceRoot, scopedPath.path, args.limit)
    : await collectTopLevelEntries(scopedPath.workspaceRoot, scopedPath.path, args.limit);
  const truncated = entries.truncated;
  const lines = entries.items.map((entry) => formatEntryPath(entry.relativePath, entry.isDirectory));
  const notices = [];

  if (truncated) {
    notices.push(`[${args.limit} entry limit reached. Use a narrower path or a higher limit for more.]`);
  }

  return {
    tool: "list_files",
    path: scopedPath.relativePath,
    content: [...(lines.length > 0 ? lines : ["(empty directory)"]), ...notices].join("\n"),
    warning: truncated ? `${args.limit} entry limit reached.` : undefined,
  };
}

async function collectTopLevelEntries(
  workspaceRoot: string,
  startPath: string,
  limit: number
): Promise<{ items: DirectoryEntry[]; truncated: boolean }> {
  const entries = await sortedDirectoryEntries(startPath);
  const items: DirectoryEntry[] = [];

  for (const entry of entries) {
    if (items.length >= limit) {
      return { items, truncated: true };
    }

    const absolutePath = join(startPath, entry.name);
    items.push({
      relativePath: relative(workspaceRoot, absolutePath) || ".",
      isDirectory: entry.isDirectory(),
    });
  }

  return { items, truncated: false };
}

async function collectRecursiveEntries(
  workspaceRoot: string,
  startPath: string,
  limit: number
): Promise<{ items: DirectoryEntry[]; truncated: boolean }> {
  const items: DirectoryEntry[] = [];
  const pending = [startPath];

  while (pending.length > 0) {
    const currentPath = pending.shift() ?? startPath;
    const entries = await sortedDirectoryEntries(currentPath);

    for (const entry of entries) {
      if (items.length >= limit) {
        return { items, truncated: true };
      }

      const absolutePath = join(currentPath, entry.name);
      const item = {
        relativePath: relative(workspaceRoot, absolutePath) || ".",
        isDirectory: entry.isDirectory(),
      };
      items.push(item);

      if (item.isDirectory) {
        pending.push(absolutePath);
      }
    }
  }

  return { items, truncated: false };
}

async function sortedDirectoryEntries(path: string) {
  const entries = await readdir(path, { withFileTypes: true });

  return entries.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
}

function formatEntryPath(path: string, isDirectory: boolean): string {
  return isDirectory ? `${path}/` : path;
}

function resolveWorkspaceScopedPath(workspaceRoot: string, path: string) {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`list_files can only list directories inside the workspace: ${path}`);
  }

  return {
    workspaceRoot: resolvedWorkspace,
    path: resolvedPath,
    relativePath: relativePath || ".",
  };
}
