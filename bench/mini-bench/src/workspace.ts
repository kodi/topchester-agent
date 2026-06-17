import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { reportsRoot } from "./paths.ts";
import type { LoadedTask } from "./task-loader.ts";

export interface PreparedWorkspace {
  runId: string;
  runPath: string;
  workspacePath: string;
  beforeHashes: Map<string, string>;
}

const ignoredNames = new Set(["node_modules", ".git", ".agents", ".pnpm-store"]);

export async function prepareWorkspace(task: LoadedTask): Promise<PreparedWorkspace> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runPath = resolve(reportsRoot, "runs", runId, task.definition.id);
  const workspacePath = resolve(runPath, "workspace");
  const sourceWorkspace = resolve(task.taskPath, task.definition.workspace);

  await rm(runPath, { recursive: true, force: true });
  await mkdir(runPath, { recursive: true });
  await cp(sourceWorkspace, workspacePath, { recursive: true, dereference: false });

  return {
    runId,
    runPath,
    workspacePath,
    beforeHashes: await hashTree(workspacePath),
  };
}

export async function overlayCandidate(task: LoadedTask, workspacePath: string, candidate: string): Promise<string> {
  const candidatePath = resolveCandidatePath(task, candidate);
  await cp(candidatePath, workspacePath, { recursive: true, force: true });
  return candidatePath;
}

export async function changedFiles(workspacePath: string, beforeHashes: Map<string, string>): Promise<string[]> {
  const after = await hashTree(workspacePath);
  const changed = new Set<string>();

  for (const [path, hash] of after) {
    if (beforeHashes.get(path) !== hash) {
      changed.add(path);
    }
  }

  for (const path of beforeHashes.keys()) {
    if (!after.has(path)) {
      changed.add(path);
    }
  }

  return [...changed].sort();
}

export async function removeRun(runPath: string): Promise<void> {
  await rm(runPath, { recursive: true, force: true });
}

function resolveCandidatePath(task: LoadedTask, candidate: string): string {
  if (candidate.includes("/") || candidate.includes("\\")) {
    return resolve(candidate);
  }

  return resolve(task.taskPath, "verifier", "fixtures", candidate);
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) {
        continue;
      }

      const path = resolve(dir, entry.name);
      const relativePath = relative(root, path);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      hashes.set(
        relativePath,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      );
    }
  }

  try {
    if ((await stat(root)).isDirectory()) {
      await walk(root);
    }
  } catch {
    return hashes;
  }

  return hashes;
}
