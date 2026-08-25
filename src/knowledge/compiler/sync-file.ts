import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TopchesterConfig } from "../../config/index.js";
import { getKnowledgeStatus } from "../status.js";
import { inspectProjectFileForL1, type ProjectFileInspection } from "./inventory.js";
import { createL1QueueItem, type L1QueueItem } from "./l1.js";
import { hasCurrentEntry, MAX_L1_PROMPT_FILE_BYTES, processL1QueueItem, type L1SummaryModel } from "./l1-processor.js";
import { knowledgeCompilerIdentity } from "./manifest.js";
import { normalizeL1FilePath } from "./path-encoding.js";

export type SyncL1FileStatus = "completed" | "failed" | "ignored" | "missing" | "changed" | "skipped_current";

export interface SyncL1FileResult {
  workspaceRoot: string;
  kbPath: string;
  path: string;
  hash?: string;
  status: SyncL1FileStatus;
  reason?: string;
  item?: L1QueueItem;
  entryPath?: string;
}

export interface SyncL1FileOptions {
  path: string;
  model?: L1SummaryModel;
  config?: TopchesterConfig;
  abortSignal?: AbortSignal;
  now?: () => Date;
}

export async function syncL1File(workspaceRoot: string, options: SyncL1FileOptions): Promise<SyncL1FileResult> {
  options.abortSignal?.throwIfAborted();
  const path = normalizeL1FilePath(options.path);
  const status = getKnowledgeStatus(workspaceRoot);
  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` before syncing the project knowledge base.");
  }

  const inspection = await inspectProjectFileForL1(workspaceRoot, path, {
    excludedPaths: [status.kbPath, status.cachePath],
    ignorePaths: options.config?.ignore?.paths ?? [],
    maxBytes: MAX_L1_PROMPT_FILE_BYTES,
  });
  options.abortSignal?.throwIfAborted();

  if (inspection.status !== "included") {
    return formatInspectionOutcome(workspaceRoot, status.kbPath, inspection);
  }

  const item = createL1QueueItem(inspection.file);
  if (await hasCurrentEntry(status.kbPath, item)) {
    return { workspaceRoot, kbPath: status.kbPath, path, hash: item.hash, status: "skipped_current", item };
  }
  if (!options.model) {
    throw new Error('No model configured for purpose "kb.summarize"; L1 entry was not processed.');
  }

  const maybeResolvable = options.model as L1SummaryModel & { resolveModel?: (purpose: "kb.summarize") => unknown };
  maybeResolvable.resolveModel?.("kb.summarize");
  const processed = await processL1QueueItem({
    workspaceRoot,
    kbPath: status.kbPath,
    item,
    model: options.model,
    abortSignal: options.abortSignal,
    now: options.now,
  });
  options.abortSignal?.throwIfAborted();

  const resultStatus = mapQueueStatus(processed.item.status);
  if (resultStatus === "completed") {
    await updateManifestBestEffort(workspaceRoot, status.kbPath, options.now ?? (() => new Date()));
  }

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    path,
    hash: item.hash,
    status: resultStatus,
    reason: processed.item.failure?.message,
    item: processed.item,
    entryPath: processed.entryPath,
  };
}

export function formatSyncL1FileResults(
  results: SyncL1FileResult[],
  options: { title?: string; model?: string } = {}
): string[] {
  const lines = [options.title ?? "KB sync", ...(options.model ? [`model: ${options.model}`] : [])];
  for (const result of results) {
    lines.push("", result.path, `status: ${result.status}`);
    if (result.hash) lines.push(`hash: ${result.hash}`);
    if (result.reason) lines.push(`reason: ${result.reason.replaceAll("_", " ")}`);
  }
  return lines;
}

export function isPartialSyncL1FileResult(result: SyncL1FileResult): boolean {
  return result.status === "failed" || result.status === "changed" || result.status === "missing";
}

function formatInspectionOutcome(
  workspaceRoot: string,
  kbPath: string,
  inspection: Exclude<ProjectFileInspection, { status: "included" }>
): SyncL1FileResult {
  if (inspection.status === "missing") {
    return { workspaceRoot, kbPath, path: inspection.path, status: "missing", reason: "file does not exist" };
  }
  return { workspaceRoot, kbPath, path: inspection.path, status: "ignored", reason: inspection.reason };
}

function mapQueueStatus(status: L1QueueItem["status"]): SyncL1FileStatus {
  if (status === "completed") return "completed";
  if (status === "changed") return "changed";
  if (status === "missing_file") return "missing";
  return "failed";
}

async function updateManifestBestEffort(workspaceRoot: string, kbPath: string, now: () => Date): Promise<void> {
  const manifestPath = join(kbPath, "manifest.json");
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const l1 = typeof parsed.l1 === "object" && parsed.l1 !== null ? (parsed.l1 as Record<string, unknown>) : {};
    const currentEntries = typeof l1.currentEntries === "number" ? l1.currentEntries : 0;
    parsed.generatedAt = now().toISOString();
    parsed.l1 = { ...l1, currentEntries: currentEntries + 1 };
    await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    const generatedAt = now().toISOString();
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: "topchester-kb",
          version: 1,
          compiler: knowledgeCompilerIdentity,
          generatedAt,
          workspaceRoot,
          queuedFileCount: 0,
          configIgnorePathCount: 0,
          l1: { queued: 0, completed: 0, failed: 0, changed: 0, missing: 0, currentEntries: 1 },
          gitignoreFiles: [],
        },
        null,
        2
      )}\n`
    ).catch(() => undefined);
  }
}
