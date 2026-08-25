import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TopchesterConfig } from "../../config/index.js";
import { getKnowledgeStatus } from "../status.js";
import { type KnowledgeProgressReporter } from "../progress.js";
import { listProjectFilesForL1 } from "./inventory.js";
import { parseL1FileEntry, type L1FileScanStatus } from "./l1-entry.js";
import { createL1QueueFile, createL1QueueItem, type L1QueueItem } from "./l1.js";
import { processL1Queue, type L1QueueProcessingSummary, type L1SummaryModel } from "./l1-processor.js";
import { knowledgeCompilerIdentity } from "./manifest.js";
import { getL1FileEntryPath } from "./path-encoding.js";

export interface KnowledgeCompileResult {
  workspaceRoot: string;
  kbPath: string;
  cachePath: string;
  gitignoreFiles: string[];
  queuedFiles: L1QueueItem[];
  queuePath: string;
  manifestPath: string;
  configIgnorePathCount: number;
  l1?: L1QueueProcessingSummary;
}

export interface KnowledgeCompileDryRunFile {
  path: string;
  sizeBytes: number;
  hash: string;
  syncStatus: L1FileScanStatus;
}

export interface KnowledgeCompileDryRunResult {
  workspaceRoot: string;
  kbPath: string;
  cachePath: string;
  kbReady: boolean;
  gitignoreFiles: string[];
  configIgnorePathCount: number;
  files: KnowledgeCompileDryRunFile[];
}

export async function syncKnowledgeBase(
  workspaceRoot: string,
  options: {
    onProgress?: KnowledgeProgressReporter;
    model?: L1SummaryModel;
    requireModel?: boolean;
    config?: TopchesterConfig;
    full?: boolean;
    abortSignal?: AbortSignal;
  } = {}
): Promise<KnowledgeCompileResult> {
  options.abortSignal?.throwIfAborted();
  options.onProgress?.({ message: "Checking project knowledge folders..." });
  const status = getKnowledgeStatus(workspaceRoot);

  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` before syncing the project knowledge base.");
  }

  await mkdir(status.cachePath, { recursive: true });
  options.onProgress?.({
    message: options.full
      ? "Reading .gitignore files and listing project files..."
      : "Reading .gitignore files and checking KB file status...",
  });
  const ignorePaths = options.config?.ignore?.paths ?? [];
  const inventory = await listProjectFilesForL1(workspaceRoot, {
    excludedPaths: [status.kbPath, status.cachePath],
    ignorePaths,
  });
  options.abortSignal?.throwIfAborted();

  const dirtyFiles = options.full
    ? inventory.files
    : (
        await Promise.all(
          inventory.files.map(async (file) => ({
            ...file,
            syncStatus: await getL1SyncStatus(status.kbPath, status.kbExists && status.kbIsDirectory, file),
          }))
        )
      ).filter((file) => file.syncStatus !== "current");
  options.abortSignal?.throwIfAborted();

  if (options.requireModel && dirtyFiles.length > 0) {
    assertKbSummarizeModelConfigured(options.model);
  }

  options.onProgress?.({
    message: options.full
      ? `Queued ${dirtyFiles.length} project files for full L1 sync...`
      : `Queued ${dirtyFiles.length} non-clean project files for L1 sync...`,
  });
  const queuedFiles = dirtyFiles.map((file) =>
    createL1QueueItem({ path: file.path, sizeBytes: file.sizeBytes, hash: file.hash })
  );
  const queuePath = join(status.cachePath, options.full ? "l1-queue.json" : "l1-sync-queue.json");
  const manifestPath = join(status.kbPath, "manifest.json");
  const generatedAt = new Date().toISOString();
  const queue = createL1QueueFile(queuedFiles, generatedAt);

  options.onProgress?.({
    message: options.full ? "Writing full L1 sync queue and manifest..." : "Writing L1 sync queue and manifest...",
  });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  const dirtyFilePaths = new Set(dirtyFiles.map((file) => file.path));
  const currentEntryCount = options.full ? 0 : inventory.files.filter((file) => !dirtyFilePaths.has(file.path)).length;
  const l1 = {
    queued: queuedFiles.length,
    completed: 0,
    failed: 0,
    changed: 0,
    missing: 0,
    currentEntries: currentEntryCount,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "topchester-kb",
        version: 1,
        compiler: knowledgeCompilerIdentity,
        generatedAt,
        workspaceRoot,
        l1QueuePath: queuePath,
        queuedFileCount: queuedFiles.length,
        configIgnorePathCount: ignorePaths.length,
        l1,
        gitignoreFiles: inventory.gitignoreFiles,
      },
      null,
      2
    )}\n`
  );
  options.abortSignal?.throwIfAborted();

  options.onProgress?.({
    message: options.full
      ? "Processing all L1 file entries with the configured model..."
      : "Processing non-clean L1 file entries with the configured model...",
  });
  const processed =
    options.model && queuedFiles.length > 0
      ? await processL1Queue({
          workspaceRoot,
          kbPath: status.kbPath,
          queuePath,
          manifestPath,
          gitignoreFiles: inventory.gitignoreFiles,
          configIgnorePathCount: ignorePaths.length,
          removeOrphanedEntries: options.full === true,
          model: options.model,
          abortSignal: options.abortSignal,
          onProgress: options.onProgress,
        })
      : undefined;

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    cachePath: status.cachePath,
    gitignoreFiles: inventory.gitignoreFiles,
    queuedFiles: processed?.queuedFiles ?? queuedFiles,
    queuePath,
    manifestPath,
    configIgnorePathCount: ignorePaths.length,
    l1: processed?.summary ?? l1,
  };
}

export async function dryRunKnowledgeCompile(
  workspaceRoot: string,
  options: { config?: TopchesterConfig } = {}
): Promise<KnowledgeCompileDryRunResult> {
  const status = getKnowledgeStatus(workspaceRoot);
  const ignorePaths = options.config?.ignore?.paths ?? [];
  const inventory = await listProjectFilesForL1(workspaceRoot, {
    excludedPaths: [status.kbPath, status.cachePath],
    ignorePaths,
  });

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    cachePath: status.cachePath,
    kbReady: Boolean(status.kbExists && status.kbIsDirectory),
    gitignoreFiles: inventory.gitignoreFiles,
    configIgnorePathCount: ignorePaths.length,
    files: await Promise.all(
      inventory.files.map(async (file) => ({
        ...file,
        syncStatus: await getL1SyncStatus(status.kbPath, status.kbExists && status.kbIsDirectory, file),
      }))
    ),
  };
}

export function formatKnowledgeSyncResult(result: KnowledgeCompileResult, options: { title?: string } = {}): string[] {
  const l1 = result.l1 ?? {
    queued: result.queuedFiles.length,
    completed: 0,
    failed: 0,
    changed: 0,
    missing: 0,
    currentEntries: 0,
  };
  const totalQueued = result.queuedFiles.length;
  const hasPartialOutcomes = l1.failed > 0 || l1.changed > 0 || l1.missing > 0;
  const state =
    l1.completed === totalQueued && !hasPartialOutcomes
      ? "L1 entries are ready and current"
      : hasPartialOutcomes
        ? "partial L1 sync; some files need attention"
        : "L1 file queue is ready";

  return [
    options.title ?? "KB sync",
    `workspace: ${result.workspaceRoot}`,
    `gitignore files read: ${result.gitignoreFiles.length}`,
    `config ignore rules: ${result.configIgnorePathCount}`,
    `queue: ${result.queuePath}`,
    `manifest: ${result.manifestPath}`,
    `queued: ${totalQueued}`,
    `completed: ${l1.completed}`,
    `failed: ${l1.failed}`,
    `changed: ${l1.changed}`,
    `missing: ${l1.missing}`,
    `current L1 entries: ${l1.currentEntries}`,
    `state: ${state}`,
  ];
}

export function formatKnowledgeCompileDryRunResult(
  result: KnowledgeCompileDryRunResult,
  options: { formatSyncStatus?: (status: L1FileScanStatus) => string } = {}
): string[] {
  return formatKnowledgeCompileInventoryResult(result, {
    title: "KB dry run",
    countLabel: "files",
    formatSyncStatus: options.formatSyncStatus,
  });
}

export function filterNonCleanKnowledgeCompileResult(
  result: KnowledgeCompileDryRunResult
): KnowledgeCompileDryRunResult {
  return {
    ...result,
    files: result.files.filter((file) => file.syncStatus !== "current"),
  };
}

export function formatKnowledgeCompileStatusResult(
  result: KnowledgeCompileDryRunResult,
  options: { formatSyncStatus?: (status: L1FileScanStatus) => string } = {}
): string[] {
  return formatKnowledgeCompileInventoryResult(result, {
    title: "KB status",
    countLabel: "non-clean files",
    emptyState: "state: all in-scope files are current",
    formatSyncStatus: options.formatSyncStatus,
  });
}

function formatKnowledgeCompileInventoryResult(
  result: KnowledgeCompileDryRunResult,
  options: {
    title: string;
    countLabel: string;
    emptyState?: string;
    formatSyncStatus?: (status: L1FileScanStatus) => string;
  }
): string[] {
  const fileRows = formatKnowledgeCompileFileRows(result.files, options.formatSyncStatus);

  return [
    options.title,
    `workspace: ${result.workspaceRoot}`,
    `knowledge folder: ${result.kbPath} ${result.kbReady ? "[ok]" : "[missing]"}`,
    `gitignore files read: ${result.gitignoreFiles.length}`,
    `config ignore rules: ${result.configIgnorePathCount}`,
    `${options.countLabel}: ${result.files.length}`,
    ...(result.files.length === 0 && options.emptyState ? [options.emptyState] : []),
    ...(fileRows.length > 0 ? ["", ...fileRows] : []),
    "----",
    `total ${options.countLabel}: ${result.files.length}`,
  ];
}

function formatKnowledgeCompileFileRows(
  files: KnowledgeCompileDryRunFile[],
  formatSyncStatus?: (status: L1FileScanStatus) => string
): string[] {
  if (files.length === 0) {
    return [];
  }

  const statusWidth = Math.max("status".length, ...files.map((file) => file.syncStatus.length));
  const sizes = files.map((file) => `${file.sizeBytes} bytes`);
  const sizeWidth = Math.max("size".length, ...sizes.map((size) => size.length));

  return [
    `${"status".padEnd(statusWidth)}  ${"size".padStart(sizeWidth)}  path`,
    ...files.map((file, index) => {
      const status = formatSyncStatus ? formatSyncStatus(file.syncStatus) : file.syncStatus;
      const statusPadding = " ".repeat(statusWidth - file.syncStatus.length);
      return `${status}${statusPadding}  ${sizes[index]!.padStart(sizeWidth)}  ${file.path}`;
    }),
  ];
}

export function isPartialKnowledgeCompileResult(result: KnowledgeCompileResult): boolean {
  const l1 = result.l1;
  return Boolean(
    l1 && (l1.failed > 0 || l1.changed > 0 || l1.missing > 0 || l1.completed !== result.queuedFiles.length)
  );
}

async function getL1SyncStatus(
  kbPath: string,
  kbReady: boolean,
  file: { path: string; sizeBytes: number; hash: string }
): Promise<L1FileScanStatus> {
  if (!kbReady) {
    return "missing_entry";
  }

  try {
    const entry = parseL1FileEntry(JSON.parse(await readFile(getL1FileEntryPath(kbPath, file.path), "utf8")));
    if (entry.path !== file.path || entry.size_bytes !== file.sizeBytes || entry.content_hash !== file.hash) {
      return "changed";
    }

    return entry.scan_status;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return "missing_entry";
    }

    return "invalid";
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertKbSummarizeModelConfigured(model: L1SummaryModel | undefined): void {
  if (!model) {
    throw new Error('No model configured for purpose "kb.summarize"; L1 entries were not processed.');
  }

  const maybeResolvable = model as L1SummaryModel & { resolveModel?: (purpose: "kb.summarize") => unknown };
  if (maybeResolvable.resolveModel) {
    maybeResolvable.resolveModel("kb.summarize");
  }
}
