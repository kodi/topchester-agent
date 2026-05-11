import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getKnowledgeStatus } from "../status.js";
import { type KnowledgeProgressReporter } from "../progress.js";
import { listProjectFilesForL1 } from "./inventory.js";
import { createL1QueueFile, createL1QueueItem, type L1QueueItem } from "./l1.js";
import { processL1Queue, type L1QueueProcessingSummary, type L1SummaryModel } from "./l1-processor.js";

export interface KnowledgeCompiler {
  compile(): Promise<KnowledgeCompileResult>;
}

export interface KnowledgeCompileResult {
  workspaceRoot: string;
  kbPath: string;
  cachePath: string;
  gitignoreFiles: string[];
  queuedFiles: L1QueueItem[];
  queuePath: string;
  manifestPath: string;
  l1?: L1QueueProcessingSummary;
}

export async function compileKnowledgeBase(
  workspaceRoot: string,
  options: { onProgress?: KnowledgeProgressReporter; model?: L1SummaryModel; requireModel?: boolean } = {}
): Promise<KnowledgeCompileResult> {
  options.onProgress?.({ message: "Checking project knowledge folders..." });
  const status = getKnowledgeStatus(workspaceRoot);

  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` before compiling the project knowledge base.");
  }

  if (options.requireModel) {
    assertKbSummarizeModelConfigured(options.model);
  }

  await mkdir(status.cachePath, { recursive: true });
  options.onProgress?.({ message: "Reading .gitignore files and listing project files..." });
  const inventory = await listProjectFilesForL1(workspaceRoot, { excludedPaths: [status.kbPath, status.cachePath] });
  options.onProgress?.({ message: `Queued ${inventory.files.length} project files for L1...` });
  const queuedFiles = inventory.files.map(createL1QueueItem);
  const queuePath = join(status.cachePath, "l1-queue.json");
  const manifestPath = join(status.kbPath, "manifest.json");
  const generatedAt = new Date().toISOString();
  const queue = createL1QueueFile(queuedFiles, generatedAt);

  options.onProgress?.({ message: "Writing L1 queue and manifest..." });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  const l1 = {
    queued: queuedFiles.length,
    completed: 0,
    failed: 0,
    changed: 0,
    missing: 0,
    currentEntries: 0,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "topchester-kb",
        version: 1,
        generatedAt,
        workspaceRoot,
        l1QueuePath: queuePath,
        queuedFileCount: queuedFiles.length,
        l1,
        gitignoreFiles: inventory.gitignoreFiles,
      },
      null,
      2
    )}\n`
  );

  options.onProgress?.({ message: "Processing L1 file entries with the configured model..." });
  const processed = options.model
    ? await processL1Queue({
        workspaceRoot,
        kbPath: status.kbPath,
        queuePath,
        manifestPath,
        gitignoreFiles: inventory.gitignoreFiles,
        model: options.model,
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
    l1: processed?.summary ?? l1,
  };
}

export function formatKnowledgeCompileResult(result: KnowledgeCompileResult): string[] {
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
        ? "partial L1 compile; some files need attention"
        : "L1 file queue is ready";

  return [
    "KB compile",
    `workspace: ${result.workspaceRoot}`,
    `gitignore files read: ${result.gitignoreFiles.length}`,
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

export function isPartialKnowledgeCompileResult(result: KnowledgeCompileResult): boolean {
  const l1 = result.l1;
  return Boolean(
    l1 && (l1.failed > 0 || l1.changed > 0 || l1.missing > 0 || l1.completed !== result.queuedFiles.length)
  );
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
