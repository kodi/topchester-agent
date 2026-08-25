import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { type BenchmarkProfile } from "../benchmark-profile.js";
import { defineTool, type FileTouchEvent, type ReadFileCache, type ToolCall, type ToolResult } from "./types.js";
import { appendProjectInstructionsToToolContent, resolveToolProjectInstructions } from "./project-instructions.js";

const DEFAULT_MAX_UTF8_READ_BYTES = 512 * 1024;
const TERMINAL_BENCH_MAX_UTF8_READ_BYTES = 64 * 1024;
const SAMPLE_BYTES = 256;

export const readFileArgsSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(DEFAULT_MAX_UTF8_READ_BYTES).optional(),
});

export type ReadFileToolArgs = z.infer<typeof readFileArgsSchema>;
export type ReadFileToolCall = ToolCall<"read_file", ReadFileToolArgs>;
export interface ReadFileToolResult extends ToolResult<"read_file"> {
  hash: string;
  skipped?: "binary" | "too_large";
  bytes?: number;
  offset?: number;
  length?: number;
  deduped?: boolean;
  truncated?: boolean;
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file inside the workspace.",
  prompt:
    'read_file: read a UTF-8 file inside the workspace. For large files, use offset and limit to read a focused byte range. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
  argsSchema: readFileArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`file:${args.path}`],
  execute: async (context, args) => {
    const result = await readWorkspaceFile(context.workspaceRoot, args.path, {
      offset: args.offset,
      limit: args.limit,
      benchmarkProfile: context.benchmarkProfile,
      cache: context.readFileCache,
      onFileTouch: context.onFileTouch,
    });
    const projectInstructions = await resolveToolProjectInstructions(context, {
      targetPath: args.path,
      skipWhenTargetIsInstructionFile: true,
    });

    return {
      ...result,
      content: appendProjectInstructionsToToolContent(result.content, projectInstructions),
      projectInstructions,
    };
  },
});

export interface ReadWorkspaceFileOptions {
  offset?: number;
  limit?: number;
  benchmarkProfile?: BenchmarkProfile;
  cache?: ReadFileCache;
  onFileTouch?: (event: FileTouchEvent) => void;
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  path: string,
  options: ReadWorkspaceFileOptions = {}
): Promise<ReadFileToolResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);
  const maxReadBytes = getReadFileMaxBytes(options.benchmarkProfile);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`read_file can only read files inside the workspace: ${path}`);
  }

  const fileStat = await stat(resolvedPath);

  if (!fileStat.isFile()) {
    throw new Error(`read_file can only read regular files: ${path}`);
  }

  const offset = options.offset ?? 0;
  const requestedLimit = options.limit;
  const hasExplicitRange = options.offset !== undefined || requestedLimit !== undefined;

  if (offset > fileStat.size) {
    throw new Error(
      `read_file offset ${offset} is beyond end of file ${relativePath || "."} (${fileStat.size} bytes).`
    );
  }

  if (!hasExplicitRange && fileStat.size > maxReadBytes) {
    const [sample, hash] = await Promise.all([readFileSample(resolvedPath, SAMPLE_BYTES), hashFile(resolvedPath)]);

    return {
      tool: "read_file",
      path: relativePath || ".",
      content: formatSkippedReadSummary({
        reason: "too_large",
        relativePath: relativePath || ".",
        bytes: fileStat.size,
        maxReadBytes,
        sample,
      }),
      hash,
      skipped: "too_large",
      bytes: fileStat.size,
      warning: `Skipped reading ${relativePath || "."}: file is ${fileStat.size} bytes, above the ${maxReadBytes} byte read_file limit.`,
    };
  }

  const hashPromise = hashFile(resolvedPath);
  const bytes = hasExplicitRange
    ? await readFileRange(resolvedPath, offset, Math.min(requestedLimit ?? maxReadBytes, maxReadBytes))
    : await readFile(resolvedPath);
  const hash = await hashPromise;
  const length = bytes.length;
  const truncated = hasExplicitRange ? offset + length < fileStat.size : false;
  const cacheKey = makeReadFileCacheKey(relativePath || ".", hash, fileStat.size, offset, length);

  if (options.cache?.seen.has(cacheKey)) {
    return {
      tool: "read_file",
      path: relativePath || ".",
      content: formatDedupedReadSummary({
        relativePath: relativePath || ".",
        bytes: fileStat.size,
        hash,
        offset,
        length,
      }),
      hash,
      bytes: fileStat.size,
      offset,
      length,
      deduped: true,
      truncated,
      warning: `Skipped repeated read of unchanged ${relativePath || "."} bytes ${offset}-${offset + length}.`,
    };
  }

  if (looksBinary(bytes) || !isValidUtf8(bytes)) {
    const sample = bytes.subarray(0, SAMPLE_BYTES);

    return {
      tool: "read_file",
      path: relativePath || ".",
      content: formatSkippedReadSummary({
        reason: "binary",
        relativePath: relativePath || ".",
        bytes: fileStat.size,
        maxReadBytes,
        sample,
      }),
      hash,
      skipped: "binary",
      bytes: fileStat.size,
      warning: `Skipped reading ${relativePath || "."}: file appears to be binary or non-UTF-8.`,
    };
  }

  const content = bytes.toString("utf8");
  options.cache?.seen.set(cacheKey, { hash, bytes: fileStat.size, offset, length });

  const result: ReadFileToolResult = {
    tool: "read_file",
    path: relativePath || ".",
    content: formatReadFileContent({
      content,
      relativePath: relativePath || ".",
      bytes: fileStat.size,
      offset,
      length,
      truncated,
      ranged: hasExplicitRange,
    }),
    hash,
  };

  if (hasExplicitRange) {
    result.bytes = fileStat.size;
    result.offset = offset;
    result.length = length;
    result.truncated = truncated;
  }

  notifyFileTouch(options.onFileTouch, { path: relativePath || ".", hash, reason: "read" });

  return result;
}

function notifyFileTouch(callback: ReadWorkspaceFileOptions["onFileTouch"], event: FileTouchEvent): void {
  try {
    callback?.(event);
  } catch {
    // Live knowledge work must never fail a successful file read.
  }
}

export function createReadFileCache(): ReadFileCache {
  return { seen: new Map() };
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, SAMPLE_BYTES));
  return sample.includes(0);
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function formatSkippedReadSummary(options: {
  reason: "binary" | "too_large";
  relativePath: string;
  bytes: number;
  maxReadBytes: number;
  sample: Buffer;
}): string {
  const reason =
    options.reason === "binary"
      ? "read_file did not return file contents because this file appears to be binary or non-UTF-8."
      : `read_file did not return file contents because this file is ${options.bytes} bytes, above the ${options.maxReadBytes} byte limit.`;
  const sampleHex =
    options.sample.length > 0
      ? options.sample
          .toString("hex")
          .match(/.{1,2}/g)
          ?.join(" ")
      : "";

  return [
    reason,
    `path: ${options.relativePath}`,
    `bytes: ${options.bytes}`,
    sampleHex ? `first_${options.sample.length}_bytes_hex: ${sampleHex}` : "first_bytes_hex: <empty>",
    "Use read_file with offset and limit for a focused byte range, or shell inspection tools such as `file`, `xxd`, `readelf`, `objdump`, `strings`, or a focused parser instead of reading the whole file into context.",
  ].join("\n");
}

function formatReadFileContent(options: {
  content: string;
  relativePath: string;
  bytes: number;
  offset: number;
  length: number;
  truncated: boolean;
  ranged: boolean;
}): string {
  if (!options.ranged) {
    return options.content;
  }

  return [
    `read_file range: ${options.relativePath} bytes ${options.offset}-${options.offset + options.length} of ${options.bytes}${options.truncated ? " (truncated)" : ""}`,
    options.content,
  ].join("\n");
}

function formatDedupedReadSummary(options: {
  relativePath: string;
  bytes: number;
  hash: string;
  offset: number;
  length: number;
}): string {
  return [
    "read_file did not return file contents because this exact unchanged file range was already shown in this session.",
    `path: ${options.relativePath}`,
    `bytes: ${options.bytes}`,
    `hash: ${options.hash}`,
    `range: ${options.offset}-${options.offset + options.length}`,
    "Use a different offset/limit if you need another part of the file.",
  ].join("\n");
}

async function readFileSample(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(sample, 0, maxBytes, 0);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readFileRange(path: string, offset: number, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(sample, 0, maxBytes, offset);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return `sha256:${hash.digest("hex")}`;
}

function getReadFileMaxBytes(benchmarkProfile: BenchmarkProfile | undefined): number {
  return benchmarkProfile === "terminal-bench" ? TERMINAL_BENCH_MAX_UTF8_READ_BYTES : DEFAULT_MAX_UTF8_READ_BYTES;
}

function makeReadFileCacheKey(path: string, hash: string, bytes: number, offset: number, length: number): string {
  return `${path}\0${hash}\0${bytes}\0${offset}\0${length}`;
}
