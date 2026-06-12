import { createHash, randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { type Logger } from "pino";
import { z } from "zod";
import { recordAgentFileEdit, type FileEditEvent } from "../../knowledge/session-overlay.js";
import { enqueueFileMutation } from "./file-mutation-queue.js";
import {
  formatProjectInstructionMutationGuardContent,
  formatProjectInstructionRetryContent,
  formatWorkspaceRelativeToolPath,
  hasExplicitProjectInstructionMutationIntent,
  isProtectedConfiguredProjectInstructionTarget,
  resolveToolProjectInstructions,
} from "./project-instructions.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const editFileEditSchema = z.object({
  old_text: z.string().describe("Exact current file text to replace; include whitespace exactly."),
  new_text: z.string().describe("Replacement text for old_text."),
});

export const editFileArgsSchema = z.object({
  path: z.string().describe("Workspace-relative path to the existing UTF-8 file to edit."),
  expected_current_hash: z
    .string()
    .optional()
    .describe(
      "Optional current file hash returned by the latest read_file result for this file. This is checked before editing to catch stale reads; it is not the hash after the edit."
    ),
  edits: z.array(editFileEditSchema).min(1).describe("Exact text replacements to apply to the original file."),
});

export type EditFileEdit = z.infer<typeof editFileEditSchema>;
export type EditFileToolArgs = z.infer<typeof editFileArgsSchema>;
export type EditFileToolCall = ToolCall<"edit_file", EditFileToolArgs>;

export interface EditFileToolResult extends ToolResult<"edit_file"> {
  diff: string;
  beforeHash: string;
  afterHash: string;
  bytesChanged: number;
  firstChangedLine: number;
  kbState: "needs_sync";
  editEvent: FileEditEvent;
}

export interface ApplyEditResult {
  newContent: string;
  diff: string;
  firstChangedLine: number;
}

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Edit an existing UTF-8 file inside the workspace with exact text replacements. Use expected_current_hash only as the current/pre-edit hash from read_file, never as a predicted post-edit hash.",
  prompt:
    'edit_file: edit an existing UTF-8 file inside the workspace with exact old_text/new_text replacements; read the file first, keep old_text small but unique, and make multiple disjoint edits for one file in one call. expected_current_hash is optional and must be the current/pre-edit hash returned by the latest read_file for that file; never invent it or use a predicted after-edit hash. To use it, reply with only JSON: {"tool":"edit_file","args":{"path":"src/example.ts","expected_current_hash":"sha256:current-file-hash-from-read_file","edits":[{"old_text":"const enabled = false;\\n","new_text":"const enabled = true;\\n"}]}}',
  argsSchema: editFileArgsSchema,
  mutatesWorkspace: true,
  requiresExclusiveWorkspace: true,
  execute: async (context, args) => {
    if (
      isProtectedConfiguredProjectInstructionTarget(context, args.path) &&
      !hasExplicitProjectInstructionMutationIntent(context.currentUserMessage, args.path)
    ) {
      const relativePath = formatWorkspaceRelativeToolPath(context.workspaceRoot, args.path);

      return {
        tool: "edit_file",
        path: relativePath,
        content: formatProjectInstructionMutationGuardContent("edit_file", relativePath),
        warning: "Project instruction files require explicit user intent before editing.",
      };
    }

    const projectInstructions = await resolveToolProjectInstructions(context, { targetPath: args.path });

    if (projectInstructions) {
      const relativePath = formatWorkspaceRelativeToolPath(context.workspaceRoot, args.path);

      return {
        tool: "edit_file",
        path: relativePath,
        content: formatProjectInstructionRetryContent("edit_file", relativePath, projectInstructions),
        warning: "Project instructions loaded; retry edit_file after applying them.",
        projectInstructions,
      };
    }

    return editWorkspaceFile(context.workspaceRoot, args, { logger: context.logger });
  },
});

interface MatchedEdit {
  edit: EditFileEdit;
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

type LineEnding = "lf" | "crlf";

export interface EditWorkspaceFileOptions {
  logger?: Logger;
}

export async function editWorkspaceFile(
  workspaceRoot: string,
  args: EditFileToolArgs,
  options: EditWorkspaceFileOptions = {}
): Promise<EditFileToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path);

  return enqueueFileMutation(scopedPath.path, async () => {
    const fileStat = await statExistingFile(scopedPath.path, args.path);
    const beforeBytes = await readFile(scopedPath.path);
    const beforeHash = hashBytes(beforeBytes);

    if (args.expected_current_hash && args.expected_current_hash !== beforeHash) {
      throw new Error(`edit_file expected_current_hash did not match ${scopedPath.relativePath}.`);
    }

    const beforeContent = decodeUtf8(scopedPath.relativePath, beforeBytes);
    const result = applyExactEdits(beforeContent, args.edits, scopedPath.relativePath);
    const afterBytes = Buffer.from(result.newContent, "utf8");
    const afterHash = hashBytes(afterBytes);

    await writeFileAtomically(scopedPath.path, afterBytes, fileStat.mode);
    const editEvent: FileEditEvent = {
      kind: "file_edit",
      source: "agent",
      path: scopedPath.relativePath,
      beforeHash,
      afterHash,
      firstChangedLine: result.firstChangedLine,
      diffSummary: summarizeDiff(result.diff),
      timestamp: new Date().toISOString(),
    };
    const overlayState = recordAgentFileEdit(workspaceRoot, editEvent);

    options.logger?.debug(
      {
        event: "file_edit",
        ...editEvent,
        kbState: overlayState.kbState,
        dirtyFileCount: overlayState.dirtyFiles.length,
      },
      "file edit"
    );

    const content = [
      `Edited ${scopedPath.relativePath}`,
      `before_hash: ${beforeHash}`,
      `after_hash: ${afterHash}`,
      `kb_state: ${overlayState.kbState}`,
      `first_changed_line: ${result.firstChangedLine}`,
      result.diff,
    ].join("\n");

    return {
      tool: "edit_file",
      path: scopedPath.relativePath,
      content,
      diff: result.diff,
      beforeHash,
      afterHash,
      bytesChanged: afterBytes.length - beforeBytes.length,
      firstChangedLine: result.firstChangedLine,
      kbState: "needs_sync",
      editEvent,
    };
  });
}

export function applyExactEdits(content: string, edits: EditFileEdit[], path = "file"): ApplyEditResult {
  const document = splitDocument(content);
  const normalizedEdits = normalizeEdits(edits);
  const matches = findMatches(document.body, normalizedEdits);

  assertNoOverlaps(matches);

  let newBody = document.body;
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    newBody = `${newBody.slice(0, match.start)}${match.newText}${newBody.slice(match.end)}`;
  }

  if (newBody === document.body) {
    throw new Error("edit_file did not change the file content.");
  }

  return {
    newContent: joinDocument(newBody, document),
    diff: createUnifiedDiff(path, document.body, newBody),
    firstChangedLine: getFirstChangedLine(document.body, newBody),
  };
}

function resolveWorkspaceScopedPath(workspaceRoot: string, path: string) {
  if (path.includes("\0")) {
    throw new Error("edit_file path is invalid.");
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`edit_file can only edit files inside the workspace: ${path}`);
  }

  return {
    workspaceRoot: resolvedWorkspace,
    path: resolvedPath,
    relativePath: relativePath || ".",
  };
}

async function statExistingFile(resolvedPath: string, originalPath: string) {
  let fileStat;

  try {
    fileStat = await stat(resolvedPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`edit_file can only edit existing files: ${originalPath}`);
    }

    throw error;
  }

  if (!fileStat.isFile()) {
    throw new Error(`edit_file can only edit regular files: ${originalPath}`);
  }

  return fileStat;
}

function decodeUtf8(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`edit_file can only edit UTF-8 text files: ${path}`);
  }
}

async function writeFileAtomically(path: string, content: Buffer, mode: number): Promise<void> {
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

function summarizeDiff(diff: string): string {
  let added = 0;
  let removed = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+") || /^\+\s*\d+ \|/.test(line)) {
      added += 1;
    } else if (line.startsWith("-") || /^-\s*\d+ \|/.test(line)) {
      removed += 1;
    }
  }

  return `+${added}/-${removed}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeEdits(edits: EditFileEdit[]): EditFileEdit[] {
  const seenOldText = new Set<string>();

  return edits.map((edit, index) => {
    const oldText = normalizeLineEndings(edit.old_text);
    const newText = normalizeLineEndings(edit.new_text);

    if (oldText.length === 0) {
      throw new Error(`edit_file old_text at index ${index} must not be empty.`);
    }

    if (seenOldText.has(oldText)) {
      throw new Error(`edit_file old_text at index ${index} duplicates an earlier edit.`);
    }

    seenOldText.add(oldText);
    return { old_text: oldText, new_text: newText };
  });
}

function findMatches(content: string, edits: EditFileEdit[]): MatchedEdit[] {
  return edits.map((edit, index) => {
    const starts = findAllOccurrences(content, edit.old_text);

    if (starts.length === 0) {
      throw new Error(`edit_file old_text at index ${index} was not found.`);
    }

    if (starts.length > 1) {
      throw new Error(`edit_file old_text at index ${index} matched ${starts.length} times; make it unique.`);
    }

    const start = starts[0]!;
    return {
      edit,
      oldText: edit.old_text,
      newText: edit.new_text,
      start,
      end: start + edit.old_text.length,
    };
  });
}

function findAllOccurrences(content: string, needle: string): number[] {
  const starts: number[] = [];
  let startIndex = 0;

  while (startIndex <= content.length) {
    const index = content.indexOf(needle, startIndex);
    if (index === -1) {
      return starts;
    }

    starts.push(index);
    startIndex = index + 1;
  }

  return starts;
}

function assertNoOverlaps(matches: MatchedEdit[]): void {
  const sortedMatches = [...matches].sort((left, right) => left.start - right.start);

  for (let index = 1; index < sortedMatches.length; index += 1) {
    const previous = sortedMatches[index - 1]!;
    const current = sortedMatches[index]!;

    if (previous.end > current.start) {
      throw new Error("edit_file edits must not overlap.");
    }
  }
}

function splitDocument(content: string): { bom: boolean; body: string; lineEnding: LineEnding } {
  const bom = content.startsWith("\uFEFF");
  const body = normalizeLineEndings(bom ? content.slice(1) : content);
  const lineEnding: LineEnding = content.includes("\r\n") ? "crlf" : "lf";

  return { bom, body, lineEnding };
}

function joinDocument(body: string, document: { bom: boolean; lineEnding: LineEnding }): string {
  const content = document.lineEnding === "crlf" ? body.replaceAll("\n", "\r\n") : body;
  return document.bom ? `\uFEFF${content}` : content;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getFirstChangedLine(oldContent: string, newContent: string): number {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const maxLength = Math.max(oldLines.length, newLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }

  return 1;
}

function createUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const prefixLength = countCommonPrefix(oldLines, newLines);
  const suffixLength = countCommonSuffix(oldLines, newLines, prefixLength);
  const oldChangedEnd = oldLines.length - suffixLength;
  const newChangedEnd = newLines.length - suffixLength;
  const contextLines = 3;
  const hunkOldStart = Math.max(0, prefixLength - contextLines);
  const hunkNewStart = Math.max(0, prefixLength - contextLines);
  const hunkOldEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const hunkNewEnd = Math.min(newLines.length, newChangedEnd + contextLines);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${formatHunkRange(hunkOldStart, hunkOldEnd)} +${formatHunkRange(hunkNewStart, hunkNewEnd)} @@`,
  ];

  const oldLineNumberWidth = String(Math.max(1, hunkOldEnd)).length;
  const newLineNumberWidth = String(Math.max(1, hunkNewEnd)).length;

  for (let index = hunkOldStart; index < prefixLength; index += 1) {
    lines.push(formatDiffLine(" ", index + 1, oldLineNumberWidth, oldLines[index]));
  }

  for (let index = prefixLength; index < oldChangedEnd; index += 1) {
    lines.push(formatDiffLine("-", index + 1, oldLineNumberWidth, oldLines[index]));
  }

  for (let index = prefixLength; index < newChangedEnd; index += 1) {
    lines.push(formatDiffLine("+", index + 1, newLineNumberWidth, newLines[index]));
  }

  for (let index = newChangedEnd; index < hunkNewEnd; index += 1) {
    lines.push(formatDiffLine(" ", index + 1, newLineNumberWidth, newLines[index]));
  }

  return lines.join("\n");
}

function formatDiffLine(prefix: " " | "-" | "+", lineNumber: number, width: number, content: string): string {
  return `${prefix}${String(lineNumber).padStart(width, " ")} │ ${content}`;
}

function formatHunkRange(startIndex: number, endIndex: number): string {
  const lineCount = endIndex - startIndex;
  const startLine = lineCount === 0 ? startIndex : startIndex + 1;
  return `${startLine},${lineCount}`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function countCommonPrefix(left: string[], right: string[]): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function countCommonSuffix(left: string[], right: string[], prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  let count = 0;

  while (count < maxLength && left[left.length - count - 1] === right[right.length - count - 1]) {
    count += 1;
  }

  return count;
}
