import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspacePath } from "../app/paths.js";

export interface KnowledgeStatus {
  workspaceRoot: string;
  kbPath: string;
  cachePath: string;
  kbExists: boolean;
  kbIsDirectory: boolean;
  cacheExists: boolean;
  cacheIsDirectory: boolean;
  kbContentState?: "empty" | "ready";
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
    kbContentState: getKbContentState(kbPath, kbStat?.isDirectory() ?? false),
    kbPathSource,
    cachePathSource,
  };
}

function getKbContentState(kbPath: string, kbIsDirectory: boolean): KnowledgeStatus["kbContentState"] {
  if (!kbIsDirectory) {
    return undefined;
  }

  const manifest = readManifest(join(kbPath, "manifest.json"));
  const l1 = isRecord(manifest) && isRecord(manifest.l1) ? manifest.l1 : undefined;
  const currentEntries = getNumber(l1, "currentEntries");
  const completed = getNumber(l1, "completed");

  return currentEntries > 0 || completed > 0 ? "ready" : "empty";
}

function readManifest(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumber(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeStat(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }

  return statSync(path);
}
