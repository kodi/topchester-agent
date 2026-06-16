import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";
import { appendProjectInstructionsToToolContent, resolveToolProjectInstructions } from "./project-instructions.js";

const MAX_UTF8_READ_BYTES = 512 * 1024;
const SAMPLE_BYTES = 256;

export const readFileArgsSchema = z.object({
  path: z.string(),
});

export type ReadFileToolArgs = z.infer<typeof readFileArgsSchema>;
export type ReadFileToolCall = ToolCall<"read_file", ReadFileToolArgs>;
export interface ReadFileToolResult extends ToolResult<"read_file"> {
  hash: string;
  skipped?: "binary" | "too_large";
  bytes?: number;
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file inside the workspace.",
  prompt:
    'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
  argsSchema: readFileArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`file:${args.path}`],
  execute: async (context, args) => {
    const result = await readWorkspaceFile(context.workspaceRoot, args.path);
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

export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<ReadFileToolResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`read_file can only read files inside the workspace: ${path}`);
  }

  const fileStat = await stat(resolvedPath);

  if (!fileStat.isFile()) {
    throw new Error(`read_file can only read regular files: ${path}`);
  }

  if (fileStat.size > MAX_UTF8_READ_BYTES) {
    const [sample, hash] = await Promise.all([readFileSample(resolvedPath, SAMPLE_BYTES), hashFile(resolvedPath)]);

    return {
      tool: "read_file",
      path: relativePath || ".",
      content: formatSkippedReadSummary({
        reason: "too_large",
        relativePath: relativePath || ".",
        bytes: fileStat.size,
        sample,
      }),
      hash,
      skipped: "too_large",
      bytes: fileStat.size,
      warning: `Skipped reading ${relativePath || "."}: file is ${fileStat.size} bytes, above the ${MAX_UTF8_READ_BYTES} byte read_file limit.`,
    };
  }

  const bytes = await readFile(resolvedPath);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  if (looksBinary(bytes) || !isValidUtf8(bytes)) {
    const sample = bytes.subarray(0, SAMPLE_BYTES);

    return {
      tool: "read_file",
      path: relativePath || ".",
      content: formatSkippedReadSummary({
        reason: "binary",
        relativePath: relativePath || ".",
        bytes: fileStat.size,
        sample,
      }),
      hash,
      skipped: "binary",
      bytes: fileStat.size,
      warning: `Skipped reading ${relativePath || "."}: file appears to be binary or non-UTF-8.`,
    };
  }

  const content = bytes.toString("utf8");

  return {
    tool: "read_file",
    path: relativePath || ".",
    content,
    hash,
  };
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
  sample: Buffer;
}): string {
  const reason =
    options.reason === "binary"
      ? "read_file did not return file contents because this file appears to be binary or non-UTF-8."
      : `read_file did not return file contents because this file is ${options.bytes} bytes, above the ${MAX_UTF8_READ_BYTES} byte limit.`;
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
    "Use shell inspection tools such as `file`, `xxd`, `readelf`, `objdump`, `strings`, or a focused parser instead of reading the whole file into context.",
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
