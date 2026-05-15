import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { type Logger } from "pino";
import { z } from "zod";
import {
  recordAgentFileCreate,
  recordAgentFileMutation,
  type FileCreateEvent,
  type FileOverwriteEvent,
} from "../../knowledge/session-overlay.js";
import { enqueueFileMutation } from "./file-mutation-queue.js";
import {
  formatProjectInstructionRetryContent,
  formatWorkspaceRelativeToolPath,
  resolveToolProjectInstructions,
} from "./project-instructions.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const writeFileArgsSchema = z.object({
  path: z.string().describe("Workspace-relative path to write."),
  content: z.string().describe("Complete UTF-8 file content to write."),
  create_parent_dirs: z
    .boolean()
    .optional()
    .describe("Create missing parent directories only when that is explicitly intended."),
  overwrite: z.boolean().optional().describe("Set true only for intentional whole-file replacement."),
  expected_current_hash: z
    .string()
    .optional()
    .describe(
      "Required with overwrite:true. Use the current file hash returned by the latest read_file result for this file. This is checked before writing and is not the hash after the write."
    ),
});

export type WriteFileToolArgs = z.infer<typeof writeFileArgsSchema>;
export type WriteFileToolCall = ToolCall<"write_file", WriteFileToolArgs>;

export interface WriteFileToolResult extends ToolResult<"write_file"> {
  hash: string;
  bytesWritten: number;
  lineCount: number;
  createdParentDirs: string[];
  kbState: "needs_sync";
  writeEvent: FileCreateEvent | FileOverwriteEvent;
  beforeHash?: string;
  bytesChanged?: number;
  lineDelta?: number;
}

export interface WriteWorkspaceFileOptions {
  logger?: Logger;
}

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a new UTF-8 file inside the workspace, or explicitly replace one. For overwrite:true, expected_current_hash must be the current/pre-write hash from read_file, never a predicted post-write hash.",
  prompt:
    'write_file: create a new UTF-8 file inside the workspace by default; use edit_file for targeted changes to existing files; pass create_parent_dirs:true only when creating the folder path is intended. Replace an existing whole file only with overwrite:true and expected_current_hash set to the current/pre-write hash returned by the latest read_file for that file; never invent it or use a predicted after-write hash. To create a file, reply with only JSON: {"tool":"write_file","args":{"path":"test/example.test.ts","content":"import { it, expect } from \\"vitest\\";\\n\\nit(\\"works\\", () => {\\n  expect(true).toBe(true);\\n});\\n","create_parent_dirs":true}}',
  argsSchema: writeFileArgsSchema,
  execute: async (context, args) => {
    const projectInstructions = await resolveToolProjectInstructions(context, { targetPath: args.path });

    if (projectInstructions) {
      const relativePath = formatWorkspaceRelativeToolPath(context.workspaceRoot, args.path);

      return {
        tool: "write_file",
        path: relativePath,
        content: formatProjectInstructionRetryContent("write_file", relativePath, projectInstructions),
        warning: "Project instructions loaded; retry write_file after applying them.",
        projectInstructions,
      };
    }

    return writeWorkspaceFile(context.workspaceRoot, args, { logger: context.logger });
  },
});

export async function writeWorkspaceFile(
  workspaceRoot: string,
  args: WriteFileToolArgs,
  options: WriteWorkspaceFileOptions = {}
): Promise<WriteFileToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path);

  return enqueueFileMutation(scopedPath.path, async () => {
    const existingTarget = await statTarget(scopedPath.path);

    if (args.overwrite) {
      return overwriteExistingFile(workspaceRoot, scopedPath, args, existingTarget, options);
    }

    if (existingTarget) {
      throw new Error(`write_file can only create new files: ${scopedPath.relativePath}`);
    }

    const createdParentDirs = await ensureParentDirectory(
      scopedPath.workspaceRoot,
      scopedPath.path,
      scopedPath.relativePath,
      Boolean(args.create_parent_dirs)
    );

    const bytes = encodeUtf8Text(args.content);
    const hash = hashBytes(bytes);
    const lineCount = countLogicalLines(args.content);

    await writeFileAtomically(scopedPath.path, bytes);

    const writeEvent: FileCreateEvent = {
      kind: "file_create",
      source: "agent",
      path: scopedPath.relativePath,
      afterHash: hash,
      firstChangedLine: 1,
      writeSummary: `created +${lineCount}`,
      timestamp: new Date().toISOString(),
    };
    const overlayState = recordAgentFileCreate(workspaceRoot, writeEvent);

    options.logger?.debug(
      {
        event: "file_create",
        ...writeEvent,
        bytesWritten: bytes.length,
        lineCount,
        createdParentDirs,
        kbState: overlayState.kbState,
        dirtyFileCount: overlayState.dirtyFiles.length,
      },
      "file create"
    );

    const content = [
      `Created ${scopedPath.relativePath}`,
      `hash: ${hash}`,
      `bytes_written: ${bytes.length}`,
      `line_count: ${lineCount}`,
      `kb_state: ${overlayState.kbState}`,
      createdParentDirs.length > 0 ? `created_parent_dirs: ${createdParentDirs.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      tool: "write_file",
      path: scopedPath.relativePath,
      content,
      hash,
      bytesWritten: bytes.length,
      lineCount,
      createdParentDirs,
      kbState: "needs_sync",
      writeEvent,
    };
  });
}

async function overwriteExistingFile(
  workspaceRoot: string,
  scopedPath: ReturnType<typeof resolveWorkspaceScopedPath>,
  args: WriteFileToolArgs,
  existingTarget: Awaited<ReturnType<typeof statTarget>>,
  options: WriteWorkspaceFileOptions
): Promise<WriteFileToolResult> {
  if (!args.expected_current_hash) {
    throw new Error(`write_file overwrite requires expected_current_hash for ${scopedPath.relativePath}.`);
  }

  if (!existingTarget) {
    throw new Error(`write_file overwrite requires an existing file: ${scopedPath.relativePath}`);
  }

  if (!existingTarget.isFile()) {
    throw new Error(`write_file overwrite requires a regular file: ${scopedPath.relativePath}`);
  }

  const beforeBytes = await readFile(scopedPath.path);
  const beforeHash = hashBytes(beforeBytes);

  if (args.expected_current_hash !== beforeHash) {
    throw new Error(`write_file expected_current_hash did not match ${scopedPath.relativePath}.`);
  }

  const beforeContent = decodeUtf8(scopedPath.relativePath, beforeBytes);
  const beforeLineCount = countLogicalLines(beforeContent);
  const afterBytes = encodeUtf8Text(args.content);
  const afterHash = hashBytes(afterBytes);
  const afterLineCount = countLogicalLines(args.content);
  const bytesChanged = afterBytes.length - beforeBytes.length;
  const lineDelta = afterLineCount - beforeLineCount;

  await writeFileAtomically(scopedPath.path, afterBytes, Number(existingTarget.mode));

  const writeEvent: FileOverwriteEvent = {
    kind: "file_overwrite",
    source: "agent",
    path: scopedPath.relativePath,
    beforeHash,
    afterHash,
    firstChangedLine: 1,
    writeSummary: `overwritten +${afterLineCount}/-${beforeLineCount}`,
    timestamp: new Date().toISOString(),
  };
  const overlayState = recordAgentFileMutation(workspaceRoot, writeEvent);

  options.logger?.debug(
    {
      event: "file_overwrite",
      ...writeEvent,
      bytesWritten: afterBytes.length,
      bytesChanged,
      lineCount: afterLineCount,
      lineDelta,
      kbState: overlayState.kbState,
      dirtyFileCount: overlayState.dirtyFiles.length,
    },
    "file overwrite"
  );

  const content = [
    `Overwrote ${scopedPath.relativePath}`,
    `before_hash: ${beforeHash}`,
    `after_hash: ${afterHash}`,
    `bytes_written: ${afterBytes.length}`,
    `bytes_changed: ${bytesChanged}`,
    `line_count: ${afterLineCount}`,
    `line_delta: ${lineDelta}`,
    `kb_state: ${overlayState.kbState}`,
  ].join("\n");

  return {
    tool: "write_file",
    path: scopedPath.relativePath,
    content,
    hash: afterHash,
    beforeHash,
    bytesWritten: afterBytes.length,
    bytesChanged,
    lineCount: afterLineCount,
    lineDelta,
    createdParentDirs: [],
    kbState: "needs_sync",
    writeEvent,
  };
}

function resolveWorkspaceScopedPath(workspaceRoot: string, path: string) {
  if (path.includes("\0") || path.length === 0) {
    throw new Error("write_file path is invalid.");
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`write_file can only write files inside the workspace: ${path}`);
  }

  if (relativePath === "") {
    throw new Error("write_file path must point to a file inside the workspace.");
  }

  return {
    workspaceRoot: resolvedWorkspace,
    path: resolvedPath,
    relativePath,
  };
}

async function statTarget(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function ensureParentDirectory(
  workspaceRoot: string,
  path: string,
  relativePath: string,
  createParentDirs: boolean
): Promise<string[]> {
  const parent = dirname(path);

  try {
    const parentStat = await stat(parent);

    if (!parentStat.isDirectory()) {
      throw new Error(`write_file parent path is not a directory: ${dirname(relativePath)}`);
    }

    return [];
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!createParentDirs) {
    throw new Error(`write_file parent directory does not exist: ${dirname(relativePath)}`);
  }

  const createdParentDirs = await collectMissingParentDirs(workspaceRoot, parent);
  await mkdir(parent, { recursive: true });

  return createdParentDirs;
}

async function collectMissingParentDirs(workspaceRoot: string, parent: string): Promise<string[]> {
  const missing: string[] = [];
  let current = parent;

  while (current !== workspaceRoot) {
    try {
      const currentStat = await stat(current);

      if (!currentStat.isDirectory()) {
        throw new Error(`write_file parent path is not a directory: ${relative(workspaceRoot, current)}`);
      }

      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }

      missing.push(relative(workspaceRoot, current));
      current = dirname(current);
    }
  }

  return missing.reverse();
}

function encodeUtf8Text(content: string): Buffer {
  if (content.includes("\0")) {
    throw new Error("write_file content must not contain NUL bytes.");
  }

  return Buffer.from(content, "utf8");
}

function decodeUtf8(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`write_file overwrite requires the existing file to be UTF-8 text: ${path}`);
  }
}

async function writeFileAtomically(path: string, content: Buffer, mode = 0o666): Promise<void> {
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.topchester-${process.pid}-${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: mode & 0o777 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function countLogicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const withoutTrailingLineEnding = content.replace(/\r?\n$/u, "");

  return withoutTrailingLineEnding.length === 0 ? 1 : withoutTrailingLineEnding.split(/\r?\n/u).length;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
