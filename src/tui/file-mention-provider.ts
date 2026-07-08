import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Logger } from "pino";
import {
  collectWorkspaceFiles,
  scoreFileMatch,
  type FindWorkspaceFilesByNameOptions,
} from "../agent/tools/find-file.js";

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_MAX_INDEX_ENTRIES = 20_000;
const DEFAULT_SUGGESTION_LIMIT = 20;

export interface FileMentionSuggestion {
  path: string;
  isDirectory: boolean;
}

export interface FileMentionProvider {
  getSuggestions(query: string, limit?: number): FileMentionSuggestion[];
}

export interface CreateFileMentionProviderOptions {
  workspaceRoot: string;
  logger?: Logger;
  onUpdate?: () => void;
  ttlMs?: number;
  maxEntries?: number;
  pathEnv?: string;
}

interface IndexedPath extends FileMentionSuggestion {
  depth: number;
}

export function createFileMentionProvider(options: CreateFileMentionProviderOptions): FileMentionProvider {
  const workspaceRoot = resolve(options.workspaceRoot);
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
  let entries: IndexedPath[] = [];
  let refreshedAt = 0;
  let indexSignature = "";
  let refreshPromise: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = buildIndex(workspaceRoot, maxEntries, {
      logger: options.logger,
      pathEnv: options.pathEnv,
    })
      .then((nextEntries) => {
        refreshedAt = Date.now();
        const nextSignature = nextEntries.map((entry) => `${entry.isDirectory ? "d" : "f"}:${entry.path}`).join("\n");
        entries = nextEntries;

        if (nextSignature !== indexSignature) {
          indexSignature = nextSignature;
          options.onUpdate?.();
        }
      })
      .catch((error: unknown) => {
        refreshedAt = Date.now();
        options.logger?.debug({ event: "file_mention_index_failed", error }, "file mention index refresh failed");
      })
      .finally(() => {
        refreshPromise = undefined;
      });

    return refreshPromise;
  };

  return {
    getSuggestions(query: string, limit = DEFAULT_SUGGESTION_LIMIT): FileMentionSuggestion[] {
      if (Date.now() - refreshedAt > ttlMs) {
        void refresh();
      }

      return rankSuggestions(entries, query, limit).map(({ path, isDirectory }) => ({ path, isDirectory }));
    },
  };
}

async function buildIndex(
  workspaceRoot: string,
  maxEntries: number,
  options: FindWorkspaceFilesByNameOptions
): Promise<IndexedPath[]> {
  const files = await collectWorkspaceFiles(workspaceRoot, workspaceRoot, ".", options);
  const byPath = new Map<string, IndexedPath>();

  for (const file of files) {
    const normalizedFile = normalizeWorkspaceRelativePath(workspaceRoot, file);
    if (!normalizedFile) {
      continue;
    }

    addParentDirectories(byPath, normalizedFile, maxEntries);
    addIndexedPath(byPath, normalizedFile, false, maxEntries);

    if (byPath.size >= maxEntries) {
      break;
    }
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function addParentDirectories(paths: Map<string, IndexedPath>, filePath: string, maxEntries: number): void {
  let directory = dirname(filePath).replaceAll("\\", "/");

  while (directory && directory !== "." && directory !== "/") {
    addIndexedPath(paths, directory, true, maxEntries);

    if (paths.size >= maxEntries) {
      return;
    }

    directory = dirname(directory).replaceAll("\\", "/");
  }
}

function addIndexedPath(paths: Map<string, IndexedPath>, path: string, isDirectory: boolean, maxEntries: number): void {
  if (paths.size >= maxEntries || paths.has(path)) {
    return;
  }

  paths.set(path, {
    path,
    isDirectory,
    depth: path.split("/").length,
  });
}

function rankSuggestions(entries: IndexedPath[], query: string, limit: number): IndexedPath[] {
  const normalizedQuery = query.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const safeLimit = Math.max(1, limit);

  if (normalizedQuery.length === 0) {
    return [...entries]
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          Number(right.isDirectory) - Number(left.isDirectory) ||
          left.path.localeCompare(right.path)
      )
      .slice(0, safeLimit);
  }

  return entries
    .map((entry): { entry: IndexedPath; score: number } | undefined => {
      const prefixScore = entry.path.startsWith(normalizedQuery)
        ? 1_100 - Math.max(0, entry.path.length - normalizedQuery.length) / 100
        : 0;
      const score = Math.max(prefixScore, scoreFileMatch(normalizedQuery, entry.path));

      return score > 0 ? { entry, score } : undefined;
    })
    .filter((match): match is { entry: IndexedPath; score: number } => Boolean(match))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.entry.isDirectory) - Number(left.entry.isDirectory) ||
        left.entry.depth - right.entry.depth ||
        left.entry.path.localeCompare(right.entry.path)
    )
    .slice(0, safeLimit)
    .map((match) => match.entry);
}

function normalizeWorkspaceRelativePath(workspaceRoot: string, path: string): string | undefined {
  const relativePath = isAbsolute(path) ? relative(workspaceRoot, path) : path;
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    isAbsolute(normalized)
  ) {
    return undefined;
  }

  return normalized;
}
