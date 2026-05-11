import { existsSync, statSync } from "node:fs";
import { resolveWorkspacePath } from "../app/paths.js";

export interface KnowledgeStatus {
  workspaceRoot: string;
  kbPath: string;
  cachePath: string;
  kbExists: boolean;
  kbIsDirectory: boolean;
  cacheExists: boolean;
  cacheIsDirectory: boolean;
  kbPathSource: "default" | "env";
  cachePathSource: "default" | "env";
}

export function getKnowledgeStatus(workspaceRoot: string): KnowledgeStatus {
  const kbPathSource = process.env.TOPCHESTER_KB_DIR ? "env" : "default";
  const cachePathSource = process.env.TOPCHESTER_KB_CACHE_DIR ? "env" : "default";
  const kbPath = resolveWorkspacePath(workspaceRoot, process.env.TOPCHESTER_KB_DIR ?? "topchester-kb");
  const cachePath = resolveWorkspacePath(
    workspaceRoot,
    process.env.TOPCHESTER_KB_CACHE_DIR ?? ".agents/topchester-kb-cache"
  );
  const kbStat = safeStat(kbPath);
  const cacheStat = safeStat(cachePath);

  return {
    workspaceRoot,
    kbPath,
    cachePath,
    kbExists: Boolean(kbStat),
    kbIsDirectory: kbStat?.isDirectory() ?? false,
    cacheExists: Boolean(cacheStat),
    cacheIsDirectory: cacheStat?.isDirectory() ?? false,
    kbPathSource,
    cachePathSource,
  };
}

function safeStat(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }

  return statSync(path);
}
