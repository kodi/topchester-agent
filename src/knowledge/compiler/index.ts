import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getKnowledgeStatus } from "../status.js";
import { type KnowledgeProgressReporter } from "../progress.js";
import { listProjectFilesForL1 } from "./inventory.js";
import { createL1QueueFile, createL1QueueItem, type L1QueueItem } from "./l1.js";

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
}

export async function compileKnowledgeBase(
  workspaceRoot: string,
  options: { onProgress?: KnowledgeProgressReporter } = {}
): Promise<KnowledgeCompileResult> {
  options.onProgress?.({ message: "Checking project knowledge folders..." });
  const status = getKnowledgeStatus(workspaceRoot);

  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` before compiling the project knowledge base.");
  }

  await mkdir(status.cachePath, { recursive: true });
  options.onProgress?.({ message: "Reading .gitignore files and listing project files..." });
  const inventory = await listProjectFilesForL1(workspaceRoot);
  options.onProgress?.({ message: `Queued ${inventory.files.length} project files for L1...` });
  const queuedFiles = inventory.files.map(createL1QueueItem);
  const queuePath = join(status.cachePath, "l1-queue.json");
  const manifestPath = join(status.kbPath, "manifest.json");
  const generatedAt = new Date().toISOString();
  const queue = createL1QueueFile(queuedFiles, generatedAt);

  options.onProgress?.({ message: "Writing L1 queue and manifest..." });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
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
        gitignoreFiles: inventory.gitignoreFiles,
      },
      null,
      2
    )}\n`
  );

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    cachePath: status.cachePath,
    gitignoreFiles: inventory.gitignoreFiles,
    queuedFiles,
    queuePath,
    manifestPath,
  };
}

export function formatKnowledgeCompileResult(result: KnowledgeCompileResult): string[] {
  return [
    "KB compile",
    `workspace: ${result.workspaceRoot}`,
    `project files queued for L1: ${result.queuedFiles.length}`,
    `gitignore files read: ${result.gitignoreFiles.length}`,
    `queue: ${result.queuePath}`,
    `manifest: ${result.manifestPath}`,
    "state: L1 file queue is ready",
  ];
}
