import { stripEmptyContainers, type L1SearchMatch } from "../search.js";
import { getKnowledgeSourceDescriptors, loadKnowledgeSource, type KnowledgeSourceRegistryOptions } from "./registry.js";
import { type KnowledgeSourceDescriptor, type KnowledgeSourceSelection } from "./types.js";

export interface KnowledgeSourcesSearchResult {
  workspaceRoot: string;
  query: string;
  selection: KnowledgeSourceSelection;
  sources: KnowledgeSourceDescriptor[];
  entryCount: number;
  invalidEntryCount: number;
  warnings: string[];
  matches: L1SearchMatch[];
}

export async function searchKnowledgeSources(
  workspaceRoot: string,
  query: string,
  selection: KnowledgeSourceSelection,
  options: { limit?: number } & KnowledgeSourceRegistryOptions = {}
): Promise<KnowledgeSourcesSearchResult> {
  const descriptors = await getKnowledgeSourceDescriptors(workspaceRoot, options);
  const ids = selection === "all" ? (["project", "topchester"] as const) : ([selection] as const);
  const matches: L1SearchMatch[] = [];
  const warnings: string[] = [];
  let entryCount = 0;
  let invalidEntryCount = 0;

  for (const id of ids) {
    try {
      const source = await loadKnowledgeSource(workspaceRoot, id, options);
      entryCount += source.entryCount;
      invalidEntryCount += source.invalidEntryCount;
      matches.push(
        ...source.index
          .search(query, { limit: id === "topchester" ? Math.min(options.limit ?? 10, 3) : options.limit })
          .map((match) => ({
            ...match,
            sourceId: source.id,
            sourceKind: source.kind,
            sourceVersion: source.version,
            readOnly: source.readOnly,
          }))
      );
    } catch (error) {
      if (selection !== "all") throw error;
      warnings.push(`${id} knowledge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    workspaceRoot,
    query,
    selection,
    sources: descriptors.filter((source) => ids.includes(source.id)),
    entryCount,
    invalidEntryCount,
    warnings,
    matches: matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)),
  };
}

export function formatKnowledgeSources(descriptors: KnowledgeSourceDescriptor[]): string[] {
  return [
    "Knowledge sources",
    ...descriptors.flatMap((source) => [
      `${source.id}\t${source.kind}\t${source.ready ? "ready" : "unavailable"}\t${source.readOnly ? "read-only" : "writable"}${source.version ? `\t${source.version}` : ""}`,
      `  path: ${source.pathLabel}`,
      `  sync: ${source.supportsSync ? "supported" : "not supported"}`,
      ...(source.warning ? [`  warning: ${source.warning}`] : []),
    ]),
  ];
}

export function formatKnowledgeSourcesSearchResult(result: KnowledgeSourcesSearchResult): string[] {
  return [
    "KB search",
    `source selection: ${result.selection}`,
    `query: ${result.query}`,
    `entries indexed: ${result.entryCount}`,
    `invalid L1 entries skipped: ${result.invalidEntryCount}`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
    `matches: ${result.matches.length}`,
    ...result.matches.flatMap((match) => [
      `${match.score}\t${match.sourceId}:${match.path}\t${match.scanStatus}\t${match.contentHash}`,
      `  reasons: ${match.reasons.join("; ") || "score match"}`,
      `  summary: ${match.summary}`,
    ]),
    "----",
    `total matches: ${result.matches.length}`,
  ];
}

export function formatKnowledgeSourcesJson(value: unknown): string {
  return JSON.stringify(stripEmptyContainers(value), null, 2);
}
