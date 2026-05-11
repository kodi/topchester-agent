import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ZodError } from "zod";
import { type ModelTextResult } from "../../model/index.js";
import { l1FileEntrySchemaPath, parseL1FileEntry, type L1FileEntry } from "./l1-entry.js";
import { type L1QueueFailure, type L1QueueItem } from "./l1.js";
import { getL1FileEntryPath, normalizeL1FilePath } from "./path-encoding.js";

const MAX_L1_PROMPT_FILE_BYTES = 256 * 1024;

export interface L1SummaryModel {
  generateText(request: { purpose: "kb.summarize"; system: string; prompt: string }): Promise<ModelTextResult>;
}

export interface ProcessL1QueueItemOptions {
  workspaceRoot: string;
  kbPath: string;
  item: L1QueueItem;
  model: L1SummaryModel;
  now?: () => Date;
}

export interface ProcessL1QueueItemResult {
  item: L1QueueItem;
  entry?: L1FileEntry;
  entryPath?: string;
}

export async function processL1QueueItem(options: ProcessL1QueueItemOptions): Promise<ProcessL1QueueItemResult> {
  const now = options.now ?? (() => new Date());
  const failedAt = () => now().toISOString();

  try {
    const normalizedPath = normalizeL1FilePath(options.item.path);
    const realWorkspaceRoot = await realpath(options.workspaceRoot);
    const queuedPath = join(realWorkspaceRoot, normalizedPath);
    const absolutePath = await realpath(queuedPath).catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });

    if (!absolutePath) {
      return { item: markTerminal(options.item, "missing_file") };
    }

    if (!isInsideDirectory(realWorkspaceRoot, absolutePath)) {
      return { item: markTerminal(options.item, "changed") };
    }

    const fileStat = await stat(absolutePath).catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });

    if (!fileStat) {
      return { item: markTerminal(options.item, "missing_file") };
    }

    if (!fileStat.isFile()) {
      return { item: failItem(options.item, "not_file", "Queued path is not a file.", failedAt()) };
    }

    const currentHash = await hashFile(absolutePath);
    if (fileStat.size !== options.item.sizeBytes || currentHash !== options.item.hash) {
      return { item: markTerminal(options.item, "changed") };
    }

    if (fileStat.size > MAX_L1_PROMPT_FILE_BYTES) {
      return {
        item: failItem(
          options.item,
          "file_too_large",
          `File is too large for V0 L1 prompt processing (${fileStat.size} bytes).`,
          failedAt()
        ),
      };
    }

    const content = await readFile(absolutePath, "utf8");
    const modelResult = await options.model.generateText({
      purpose: "kb.summarize",
      system: buildL1FileEntrySystemPrompt(),
      prompt: buildL1FileEntryPrompt({ path: normalizedPath, content }),
    });
    const modelEntry = parseL1ModelJson(modelResult.text);
    const entry = normalizeL1FileEntry(modelEntry, {
      path: normalizedPath,
      hash: currentHash,
      sizeBytes: fileStat.size,
      scannedAt: now().toISOString(),
    });
    const entryPath = getL1FileEntryPath(options.kbPath, normalizedPath);

    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    return { item: markTerminal(options.item, "completed"), entry, entryPath };
  } catch (error) {
    return { item: failItem(options.item, classifyFailure(error), sanitizeErrorMessage(error), failedAt()) };
  }
}

export function buildL1FileEntrySystemPrompt(): string {
  return [
    "You summarize one repository file for Topchester's L1 knowledge base.",
    "Return exactly one JSON object and no markdown.",
    "Do not include secrets, credentials, or raw provider payloads.",
  ].join("\n");
}

export function buildL1FileEntryPrompt(input: { path: string; content: string }): string {
  return [
    "Create an L1 file entry for this workspace-relative path.",
    "The compiler will overwrite id, path, content_hash, size_bytes, last_scanned_at, and scan_status.",
    "Use this JSON shape:",
    JSON.stringify(
      {
        $schema: l1FileEntrySchemaPath,
        id: "file:<path>",
        layer: "L1",
        type: "file",
        path: "<path>",
        language: "typescript",
        content_hash: "sha256:<hash>",
        size_bytes: 0,
        last_scanned_at: "2026-05-11T00:00:00Z",
        scan_status: "current",
        summary: "One clear sentence.",
        responsibilities: ["What this file owns or does."],
        symbols: [],
        imports: [],
        exports: [],
        module_ids: [],
        feature_ids: [],
        test_ids: [],
        evidence: [{ kind: "path", value: "<path>" }],
        confidence: "medium",
      },
      null,
      2
    ),
    `Path: ${input.path}`,
    "File content:",
    "```",
    input.content,
    "```",
  ].join("\n");
}

export function parseL1ModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model returned empty output.");
  }

  const jsonObjects = extractTopLevelJsonObjects(trimmed);
  if (jsonObjects.length !== 1) {
    throw new Error(
      jsonObjects.length === 0 ? "Model output did not contain a JSON object." : "Model output was ambiguous."
    );
  }

  return JSON.parse(jsonObjects[0]);
}

function normalizeL1FileEntry(
  value: unknown,
  deterministic: { path: string; hash: string; sizeBytes: number; scannedAt: string }
): L1FileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model JSON was not an object.");
  }

  return parseL1FileEntry({
    ...value,
    $schema: l1FileEntrySchemaPath,
    id: `file:${deterministic.path}`,
    layer: "L1",
    type: "file",
    path: deterministic.path,
    content_hash: deterministic.hash,
    size_bytes: deterministic.sizeBytes,
    last_scanned_at: deterministic.scannedAt,
    scan_status: "current",
  });
}

function extractTopLevelJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects.filter((objectText) => {
    try {
      JSON.parse(objectText);
      return true;
    } catch {
      return false;
    }
  });
}

async function hashFile(absolutePath: string): Promise<string> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const hash = createHash("sha256");
    const stream = fileHandle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await fileHandle.close();
  }
}

function markTerminal(item: L1QueueItem, status: "completed" | "changed" | "missing_file"): L1QueueItem {
  const { failure: _failure, ...rest } = item;
  return { ...rest, status };
}

function failItem(item: L1QueueItem, code: string, message: string, failedAt: string): L1QueueItem {
  return { ...item, status: "failed", failure: sanitizeFailure({ code, message, failedAt }) };
}

function sanitizeFailure(failure: L1QueueFailure): L1QueueFailure {
  return {
    code: failure.code.replace(/[^a-z0-9_]/gi, "_").slice(0, 64) || "failed",
    message: sanitizeErrorText(failure.message),
    failedAt: failure.failedAt,
  };
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return `L1 entry validation failed: ${error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`;
  }
  if (error instanceof SyntaxError) {
    return "Model output was not valid JSON.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "L1 processing failed.";
}

function sanitizeErrorText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/SECRET_SENTINEL_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 500);
}

function classifyFailure(error: unknown): string {
  if (error instanceof ZodError) {
    return "validation_error";
  }
  if (error instanceof SyntaxError) {
    return "json_parse_error";
  }
  return "processing_error";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isInsideDirectory(directory: string, target: string): boolean {
  const relativePath = relative(directory, target);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && relativePath !== "..")
  );
}
