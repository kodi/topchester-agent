import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type KnowledgeProgressReporter } from "./progress.js";
import { getKnowledgeStatus } from "./status.js";

export interface KnowledgeResetResult {
  workspaceRoot: string;
  removedPaths: string[];
  missingPaths: string[];
}

export async function resetKnowledgeBase(
  workspaceRoot: string,
  options: { onProgress?: KnowledgeProgressReporter } = {}
): Promise<KnowledgeResetResult> {
  options.onProgress?.({ message: "Checking project knowledge paths..." });
  const status = getKnowledgeStatus(workspaceRoot);
  const paths = dedupePaths([status.kbPath, status.cachePath]);
  const removedPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const path of paths) {
    assertSafeResetPath(workspaceRoot, path);
    options.onProgress?.({ message: `Removing ${path}...` });
    const removed = await removeIfPresent(path);

    if (removed) {
      removedPaths.push(path);
    } else {
      missingPaths.push(path);
    }
  }

  return {
    workspaceRoot,
    removedPaths,
    missingPaths,
  };
}

export function formatKnowledgeResetResult(result: KnowledgeResetResult): string[] {
  const lines = ["KB reset", `workspace: ${result.workspaceRoot}`];

  for (const path of result.removedPaths) {
    lines.push(`removed: ${path}`);
  }

  for (const path of result.missingPaths) {
    lines.push(`already missing: ${path}`);
  }

  lines.push("state: project knowledge base was reset");
  lines.push("next: run `topchester kb init` to start clean");

  return lines;
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function assertSafeResetPath(workspaceRoot: string, path: string): void {
  const workspace = resolve(workspaceRoot);
  const target = resolve(path);

  if (target === workspace) {
    throw new Error(`Refusing to reset KB because the configured KB path is the workspace root: ${target}`);
  }

  if (dirname(target) === target) {
    throw new Error(`Refusing to reset KB because the configured KB path is a filesystem root: ${target}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
