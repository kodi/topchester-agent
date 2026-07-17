import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTopchesterVersion } from "../../version.js";
import { parseProductKnowledgeManifest } from "../product/manifest.js";
import { loadL1KnowledgeIndexFromRoot } from "../search.js";
import { type KnowledgeSourceDescriptor, type LoadedKnowledgeSource } from "./types.js";

export interface BuiltinProductSourceOptions {
  packageRoot?: string;
  productVersion?: string;
}

const loadedSourceCache = new Map<string, Promise<LoadedKnowledgeSource>>();

export async function getBuiltinProductKnowledgeSource(
  options: BuiltinProductSourceOptions = {}
): Promise<KnowledgeSourceDescriptor> {
  const packageRoot = options.packageRoot ?? resolveTopchesterPackageRoot();
  const rootPath = join(packageRoot, "resources", "knowledge", "topchester");
  const pathLabel = "resources/knowledge/topchester";
  const expectedVersion = options.productVersion ?? getTopchesterVersion();

  try {
    const manifest = parseProductKnowledgeManifest(JSON.parse(await readFile(join(rootPath, "manifest.json"), "utf8")));
    if (manifest.productVersion !== expectedVersion) {
      return {
        id: "topchester",
        kind: "builtin-product",
        rootPath,
        pathLabel,
        readOnly: true,
        ready: false,
        supportsSync: false,
        version: manifest.productVersion,
        warning: `Built-in product knowledge is for ${manifest.productVersion}, not installed Topchester ${expectedVersion}.`,
      };
    }

    return {
      id: "topchester",
      kind: "builtin-product",
      rootPath,
      pathLabel,
      readOnly: true,
      ready: true,
      supportsSync: false,
      version: manifest.productVersion,
    };
  } catch (error) {
    return {
      id: "topchester",
      kind: "builtin-product",
      rootPath,
      pathLabel,
      readOnly: true,
      ready: false,
      supportsSync: false,
      warning: `Built-in product knowledge is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadBuiltinProductKnowledgeSource(
  options: BuiltinProductSourceOptions = {}
): Promise<LoadedKnowledgeSource> {
  const descriptor = await getBuiltinProductKnowledgeSource(options);
  if (!descriptor.ready) throw new Error(descriptor.warning ?? "Built-in product knowledge is unavailable.");
  const cacheKey = `${descriptor.rootPath}\0${descriptor.version ?? ""}`;
  let cached = loadedSourceCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const loaded = await loadL1KnowledgeIndexFromRoot(descriptor.rootPath, descriptor.rootPath);
      return {
        ...descriptor,
        index: loaded.index,
        entryCount: loaded.index.size,
        invalidEntryCount: loaded.invalidEntryCount,
        ...(loaded.invalidEntryCount > 0
          ? { warning: `${loaded.invalidEntryCount} invalid built-in product entries were skipped.` }
          : {}),
      };
    })();
    loadedSourceCache.set(cacheKey, cached);
  }
  return cached;
}

export function resolveTopchesterPackageRoot(currentFile = fileURLToPath(import.meta.url)): string {
  const currentDir = dirname(currentFile);
  const candidates = [resolve(currentDir, ".."), resolve(currentDir, "../../..")];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? candidates[0]!;
}

export function clearBuiltinProductKnowledgeCache(): void {
  loadedSourceCache.clear();
}
