import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ZodError } from "zod";
import { type ModelTextResult } from "../../model/index.js";
import { type KnowledgeProgressReporter } from "../progress.js";
import { l1FileEntrySchemaPath, parseL1FileEntry, type L1FileEntry } from "./l1-entry.js";
import { createL1QueueFile, l1QueueFileSchema, type L1QueueFailure, type L1QueueItem } from "./l1.js";
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

export interface ProcessL1QueueOptions {
  workspaceRoot: string;
  kbPath: string;
  queuePath: string;
  manifestPath: string;
  gitignoreFiles: string[];
  model: L1SummaryModel;
  onProgress?: KnowledgeProgressReporter;
  now?: () => Date;
}

export interface L1QueueProcessingSummary {
  queued: number;
  completed: number;
  failed: number;
  changed: number;
  missing: number;
  currentEntries: number;
}

export interface ProcessL1QueueResult {
  queuedFiles: L1QueueItem[];
  summary: L1QueueProcessingSummary;
}

export async function processL1Queue(options: ProcessL1QueueOptions): Promise<ProcessL1QueueResult> {
  const now = options.now ?? (() => new Date());
  const queue = l1QueueFileSchema.parse(JSON.parse(await readFile(options.queuePath, "utf8")));
  let queuedFiles = queue.queuedFiles.map(validateQueueItemPath);

  await removeOrphanedL1Entries(options.kbPath, new Set(queuedFiles.map((item) => item.path)));

  for (const [index, item] of queuedFiles.entries()) {
    options.onProgress?.({
      message: formatL1ProgressMessage("Processing L1 files", index, queuedFiles.length, item.path),
    });

    if (item.status === "completed" && (await hasCurrentEntry(options.kbPath, item))) {
      options.onProgress?.({
        message: formatL1ProgressMessage("Processing L1 files", index + 1, queuedFiles.length, item.path),
      });
      continue;
    }

    queuedFiles[index] = markInProgress(item);
    await persistQueue(options.queuePath, queuedFiles, now().toISOString());

    if (await hasCurrentEntry(options.kbPath, item)) {
      queuedFiles[index] = markTerminal(item, "completed");
    } else {
      const result = await processL1QueueItem({ ...options, item, now });
      queuedFiles[index] = result.item;
    }

    await persistQueue(options.queuePath, queuedFiles, now().toISOString());
    options.onProgress?.({
      message: formatL1ProgressMessage("Processing L1 files", index + 1, queuedFiles.length, item.path),
    });
  }

  const summary = await summarizeL1Queue(options.kbPath, queuedFiles);
  await writeManifest(options, summary, now().toISOString());
  return { queuedFiles, summary };
}

function formatL1ProgressMessage(label: string, completed: number, total: number, path: string): string {
  const percent = total === 0 ? 100 : Math.floor((completed / total) * 100);
  const width = 20;
  const filled = total === 0 ? width : Math.floor((completed / total) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `${label} [${bar}] ${completed}/${total} (${percent}%) ${path}`;
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
    ...normalizeModelOwnedL1Fields(value, deterministic.path),
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

function normalizeModelOwnedL1Fields(value: object, path: string): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return {
    ...record,
    responsibilities: normalizeStringArray(record.responsibilities),
    symbols: normalizeSymbols(record.symbols, path),
    imports: normalizePrefixedIds(record.imports, "file:"),
    exports: normalizeStringArray(record.exports),
    module_ids: normalizePrefixedIds(record.module_ids, "module:"),
    feature_ids: normalizePrefixedIds(record.feature_ids, "feature:"),
    test_ids: normalizePrefixedIds(record.test_ids, "file:"),
    evidence: normalizeEvidence(record.evidence),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizePrefixedIds(value: unknown, prefix: string): string[] {
  return normalizeStringArray(value).filter((item) => item.startsWith(prefix));
}

function normalizeEvidence(value: unknown): Array<{ kind: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== "string" || record.kind.trim().length === 0) {
      return [];
    }
    if (typeof record.value !== "string" || record.value.trim().length === 0) {
      return [];
    }
    return [{ kind: record.kind, value: record.value }];
  });
}

function normalizeSymbols(value: unknown, path: string | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name || !path) {
        return [];
      }
      return [
        {
          id: `symbol:${path}#${name}`,
          kind: "symbol",
          name,
          exported: false,
          summary: `Symbol named ${name}.`,
        },
      ];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const rawId = typeof record.id === "string" && record.id.startsWith("symbol:") ? record.id : undefined;
    const name =
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name
        : rawId?.slice(rawId.lastIndexOf("#") + 1);
    if (!name || !path) {
      return [];
    }
    return [
      {
        id: rawId ?? `symbol:${path}#${name}`,
        kind: typeof record.kind === "string" && record.kind.trim().length > 0 ? record.kind : "symbol",
        name,
        exported: typeof record.exported === "boolean" ? record.exported : false,
        summary:
          typeof record.summary === "string" && record.summary.trim().length > 0
            ? record.summary
            : `Symbol named ${name}.`,
      },
    ];
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

function markInProgress(item: L1QueueItem): L1QueueItem {
  const { failure: _failure, ...rest } = item;
  return { ...rest, status: "in_progress" };
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

function validateQueueItemPath(item: L1QueueItem): L1QueueItem {
  const normalizedPath = normalizeL1FilePath(item.path);
  if (item.path !== normalizedPath || item.id !== `file:${normalizedPath}`) {
    throw new Error(`Invalid persisted L1 queue item path: ${item.path}`);
  }
  return item;
}

async function persistQueue(queuePath: string, queuedFiles: L1QueueItem[], generatedAt: string): Promise<void> {
  const queue = createL1QueueFile(queuedFiles, generatedAt);
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
}

async function hasCurrentEntry(kbPath: string, item: L1QueueItem): Promise<boolean> {
  try {
    const entryPath = getL1FileEntryPath(kbPath, item.path);
    const entry = parseL1FileEntry(JSON.parse(await readFile(entryPath, "utf8")));
    return entry.scan_status === "current" && entry.path === item.path && entry.content_hash === item.hash;
  } catch {
    return false;
  }
}

async function removeOrphanedL1Entries(kbPath: string, currentPaths: Set<string>): Promise<void> {
  const entriesDir = join(kbPath, "l1-files");
  const entryPaths = await listL1EntryJsonFiles(entriesDir).catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });

  for (const entryPath of entryPaths) {
    try {
      const entry = parseL1FileEntry(JSON.parse(await readFile(entryPath, "utf8")));
      if (!currentPaths.has(entry.path)) {
        await rm(entryPath, { force: true });
      }
    } catch {
      await rm(entryPath, { force: true });
    }
  }
}

async function listL1EntryJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await listL1EntryJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

async function summarizeL1Queue(kbPath: string, queuedFiles: L1QueueItem[]): Promise<L1QueueProcessingSummary> {
  let currentEntries = 0;
  for (const item of queuedFiles) {
    if (await hasCurrentEntry(kbPath, item)) {
      currentEntries += 1;
    }
  }

  return {
    queued: queuedFiles.filter((item) => item.status === "queued" || item.status === "in_progress").length,
    completed: queuedFiles.filter((item) => item.status === "completed").length,
    failed: queuedFiles.filter((item) => item.status === "failed").length,
    changed: queuedFiles.filter((item) => item.status === "changed").length,
    missing: queuedFiles.filter((item) => item.status === "missing_file").length,
    currentEntries,
  };
}

async function writeManifest(
  options: ProcessL1QueueOptions,
  summary: L1QueueProcessingSummary,
  generatedAt: string
): Promise<void> {
  await writeFile(
    options.manifestPath,
    `${JSON.stringify(
      {
        name: "topchester-kb",
        version: 1,
        generatedAt,
        workspaceRoot: options.workspaceRoot,
        l1QueuePath: options.queuePath,
        queuedFileCount: summary.queued + summary.completed + summary.failed + summary.changed + summary.missing,
        l1: summary,
        gitignoreFiles: options.gitignoreFiles,
      },
      null,
      2
    )}\n`
  );
}
