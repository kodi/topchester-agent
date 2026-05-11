import { mkdir, stat } from "node:fs/promises";
import { getTopchesterLogsPath, getTopchesterSessionsPath, getTopchesterStatePath } from "../app/paths.js";
import { type KnowledgeProgressReporter } from "./progress.js";
import { getKnowledgeStatus } from "./status.js";

export interface KnowledgeInitResult {
  workspaceRoot: string;
  createdPaths: string[];
  existingPaths: string[];
}

export async function initializeKnowledgeBase(
  workspaceRoot: string,
  options: { onProgress?: KnowledgeProgressReporter } = {}
): Promise<KnowledgeInitResult> {
  options.onProgress?.({ message: "Checking project knowledge folders..." });
  const status = getKnowledgeStatus(workspaceRoot);
  const paths = [
    getTopchesterStatePath(workspaceRoot),
    getTopchesterSessionsPath(workspaceRoot),
    getTopchesterLogsPath(workspaceRoot),
    status.kbPath,
    `${status.kbPath}/l1-files`,
    `${status.kbPath}/l2-modules`,
    `${status.kbPath}/l3-features`,
    `${status.kbPath}/graph`,
    `${status.kbPath}/reviews`,
    status.cachePath,
  ];
  const createdPaths: string[] = [];
  const existingPaths: string[] = [];

  for (const path of paths) {
    options.onProgress?.({ message: `Preparing ${path}...` });
    if (await directoryExists(path)) {
      existingPaths.push(path);
      continue;
    }

    await mkdir(path, { recursive: true });
    createdPaths.push(path);
  }

  return {
    workspaceRoot,
    createdPaths,
    existingPaths,
  };
}

export function formatKnowledgeInitResult(result: KnowledgeInitResult): string[] {
  const lines = ["KB init", `workspace: ${result.workspaceRoot}`];

  for (const path of result.createdPaths) {
    lines.push(`created: ${path}`);
  }

  for (const path of result.existingPaths) {
    lines.push(`already exists: ${path}`);
  }

  lines.push("state: project knowledge folders are ready");

  return lines;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);

    if (!pathStat.isDirectory()) {
      throw new Error(`${path} exists but is not a folder`);
    }

    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
