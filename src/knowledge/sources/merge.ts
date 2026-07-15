import {
  createL1ContextPackFromIndex,
  formatL1ContextPackForPrompt,
  type L1ContextPackFile,
  type L1ContextPackResult,
} from "../search.js";
import { getWorkspaceKnowledgeSource, loadWorkspaceKnowledgeSource } from "./workspace.js";
import { getBuiltinProductKnowledgeSource, loadBuiltinProductKnowledgeSource } from "./builtin-product.js";
import { shouldRouteToTopchesterProduct } from "./routing.js";
import { type KnowledgeSourceDescriptor } from "./types.js";
import { type KnowledgeSourceRegistryOptions } from "./registry.js";
import { loadKnowledgeSource } from "./registry.js";
import { type KnowledgeSourceSelection } from "./types.js";

export interface AutomaticKnowledgeContextResult {
  contextPack?: L1ContextPackResult;
  selectedSourceIds: string[];
  sourceMatchCounts: Record<string, number>;
  warnings: string[];
}

export async function createAutomaticKnowledgeContext(
  workspaceRoot: string,
  query: string,
  options: KnowledgeSourceRegistryOptions = {}
): Promise<AutomaticKnowledgeContextResult> {
  const selectedSourceIds: string[] = [];
  const sourceMatchCounts: Record<string, number> = {};
  const warnings: string[] = [];
  const packs: L1ContextPackResult[] = [];
  const project = getWorkspaceKnowledgeSource(workspaceRoot);
  if (project.ready) {
    selectedSourceIds.push(project.id);
    try {
      packs.push(toContextPack(await loadWorkspaceKnowledgeSource(workspaceRoot), workspaceRoot, query, 8, 12));
    } catch (error) {
      warnings.push(formatSourceFailure(project, error));
    }
  }

  if (shouldRouteToTopchesterProduct(query)) {
    const product = await getBuiltinProductKnowledgeSource(options);
    selectedSourceIds.push(product.id);
    if (product.ready) {
      try {
        packs.push(toContextPack(await loadBuiltinProductKnowledgeSource(options), workspaceRoot, query, 3, 12));
      } catch (error) {
        warnings.push(formatSourceFailure(product, error));
      }
    } else if (product.warning) {
      warnings.push(product.warning);
    }
  }

  for (const pack of packs) sourceMatchCounts[pack.sourceId ?? "project"] = pack.relevantFiles.length;
  const matchingPacks = packs.filter((pack) => pack.relevantFiles.length > 0);
  return {
    contextPack:
      matchingPacks.length > 0 ? mergeContextPacks(workspaceRoot, query, matchingPacks, warnings) : undefined,
    selectedSourceIds,
    sourceMatchCounts,
    warnings,
  };
}

export async function createSelectedKnowledgeContext(
  workspaceRoot: string,
  query: string,
  selection: KnowledgeSourceSelection,
  options: KnowledgeSourceRegistryOptions & { limit?: number; minScore?: number; includeFullL1?: boolean } = {}
): Promise<AutomaticKnowledgeContextResult> {
  const ids = selection === "all" ? (["project", "topchester"] as const) : ([selection] as const);
  const packs: L1ContextPackResult[] = [];
  const warnings: string[] = [];
  const sourceMatchCounts: Record<string, number> = {};

  for (const id of ids) {
    try {
      const source = await loadKnowledgeSource(workspaceRoot, id, options);
      const requestedLimit = options.limit ?? (id === "topchester" ? 3 : 8);
      const pack = toContextPack(
        source,
        workspaceRoot,
        query,
        id === "topchester" ? Math.min(requestedLimit, 3) : requestedLimit,
        options.minScore ?? 12,
        options.includeFullL1
      );
      packs.push(pack);
      sourceMatchCounts[id] = pack.relevantFiles.length;
    } catch (error) {
      if (selection !== "all") throw error;
      warnings.push(`${id} knowledge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const matchingPacks = packs.filter((pack) => pack.relevantFiles.length > 0);
  return {
    contextPack:
      matchingPacks.length > 0 ? mergeContextPacks(workspaceRoot, query, matchingPacks, warnings) : undefined,
    selectedSourceIds: [...ids],
    sourceMatchCounts,
    warnings,
  };
}

function toContextPack(
  source: Awaited<ReturnType<typeof loadWorkspaceKnowledgeSource>>,
  workspaceRoot: string,
  query: string,
  limit: number,
  minScore: number,
  includeFullL1?: boolean
): L1ContextPackResult {
  return createL1ContextPackFromIndex(
    {
      workspaceRoot,
      kbPath: source.rootPath,
      index: source.index,
      invalidEntryCount: source.invalidEntryCount,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceVersion: source.version,
      readOnly: source.readOnly,
    },
    query,
    { limit, minScore, includeFullL1 }
  );
}

function mergeContextPacks(
  workspaceRoot: string,
  query: string,
  packs: L1ContextPackResult[],
  sourceWarnings: string[]
): L1ContextPackResult {
  const relevantFiles = dedupeSourceFiles(packs.flatMap((pack) => pack.relevantFiles));
  const paths = relevantFiles.slice(0, 5).map((file) => `${file.sourceId ?? "project"}:${file.path}`);
  return {
    workspaceRoot,
    kbPath: "multiple knowledge sources",
    query,
    entryCount: packs.reduce((sum, pack) => sum + pack.entryCount, 0),
    invalidEntryCount: packs.reduce((sum, pack) => sum + pack.invalidEntryCount, 0),
    selection: {
      limit: packs.reduce((sum, pack) => sum + pack.selection.limit, 0),
      minScore: Math.min(...packs.map((pack) => pack.selection.minScore)),
    },
    drift: {
      status: packs.every((pack) => pack.drift.status === "immutable") ? "immutable" : "unchecked",
      warnings: packs.flatMap((pack) => pack.drift.warnings),
    },
    summary: `Likely relevant knowledge for "${query}": ${paths.join(", ")}${relevantFiles.length > paths.length ? ", ..." : ""}.`,
    warnings: sourceWarnings,
    relevantFiles,
  };
}

function dedupeSourceFiles(files: L1ContextPackFile[]): L1ContextPackFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.sourceId ?? "project"}\0${file.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatSourceFailure(source: KnowledgeSourceDescriptor, error: unknown): string {
  return `${source.id} knowledge failed: ${error instanceof Error ? error.message : String(error)}`;
}

export { formatL1ContextPackForPrompt };
