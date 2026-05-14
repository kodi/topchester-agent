import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getKnowledgeStatus } from "./status.js";
import { parseL1FileEntry, type L1FileEntry } from "./compiler/l1-entry.js";

type L1SearchField =
  | "path"
  | "symbol"
  | "export"
  | "responsibility"
  | "summary"
  | "import"
  | "test"
  | "relationship"
  | "evidence";

interface L1SearchPosting {
  entryId: string;
  field: L1SearchField;
  weight: number;
}

export interface L1SearchOptions {
  limit?: number;
}

export interface L1ContextPackOptions {
  limit?: number;
  minScore?: number;
  includeFullL1?: boolean;
}

export interface L1SearchMatch {
  id: string;
  path: string;
  score: number;
  summary: string;
  contentHash: string;
  scanStatus: L1FileEntry["scan_status"];
  reasons: string[];
}

export interface L1KnowledgeSearchResult {
  workspaceRoot: string;
  kbPath: string;
  query: string;
  entryCount: number;
  invalidEntryCount: number;
  matches: L1SearchMatch[];
}

export interface L1ContextPackKnowledge {
  file_role: L1FileEntry["file_role"];
  summary: string;
  responsibilities?: string[];
  symbols?: Array<Pick<L1FileEntry["symbols"][number], "name" | "exported"> & { kind?: string; summary?: string }>;
  imports?: string[];
  exports?: string[];
  module_ids?: string[];
  feature_ids?: string[];
  test_ids?: string[];
  declared_test_targets?: string[];
  likely_test_targets?: string[];
  tested_by?: string[];
  confidence: L1FileEntry["confidence"];
}

export interface L1ContextPackFile {
  id: string;
  path: string;
  score: number;
  reasons: string[];
  contentHash: string;
  scanStatus: L1FileEntry["scan_status"];
  l1: L1ContextPackKnowledge;
  fullL1?: L1FileEntry;
}

export interface L1ContextPackResult {
  workspaceRoot: string;
  kbPath: string;
  query: string;
  entryCount: number;
  invalidEntryCount: number;
  selection: {
    limit: number;
    minScore: number;
  };
  drift: {
    status: "unchecked";
    warnings: string[];
  };
  summary: string;
  warnings: string[];
  relevantFiles: L1ContextPackFile[];
}

export class L1InMemoryIndex {
  private readonly entriesById = new Map<string, L1FileEntry>();
  private readonly postingsByToken = new Map<string, L1SearchPosting[]>();

  constructor(entries: L1FileEntry[]) {
    for (const entry of entries) {
      this.entriesById.set(entry.id, entry);
      this.indexEntry(entry);
    }
  }

  get size(): number {
    return this.entriesById.size;
  }

  search(query: string, options: L1SearchOptions = {}): L1SearchMatch[] {
    const tokens = tokenizeQuery(query);
    const scoresByEntryId = new Map<string, number>();
    const reasonsByEntryId = new Map<string, Map<string, number>>();

    for (const token of tokens) {
      this.addMatches(token, 1, scoresByEntryId, reasonsByEntryId);
      if (token.length >= 4) {
        this.addPrefixMatches(token, scoresByEntryId, reasonsByEntryId);
      }
    }

    const limit = options.limit ?? 10;
    return [...scoresByEntryId.entries()]
      .map(([entryId, score]) => {
        const entry = this.entriesById.get(entryId);

        if (!entry) {
          return undefined;
        }

        return {
          id: entry.id,
          path: entry.path,
          score: Math.round(score * 100) / 100,
          summary: entry.summary,
          contentHash: entry.content_hash,
          scanStatus: entry.scan_status,
          reasons: [...(reasonsByEntryId.get(entryId) ?? new Map<string, number>()).entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([reason]) => reason)
            .slice(0, 6),
        };
      })
      .filter((match): match is L1SearchMatch => Boolean(match))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  getEntry(id: string): L1FileEntry | undefined {
    return this.entriesById.get(id);
  }

  private indexEntry(entry: L1FileEntry): void {
    this.addField(entry, "path", [entry.path, basename(entry.path)], 6);
    this.addField(
      entry,
      "symbol",
      entry.symbols.flatMap((symbol) => [symbol.name, symbol.kind, symbol.summary].filter(isString)),
      10
    );
    this.addField(entry, "export", entry.exports, 9);
    this.addField(entry, "responsibility", entry.responsibilities, 6);
    this.addField(entry, "summary", [entry.summary], 5);
    this.addField(entry, "import", entry.imports, 4);
    this.addField(entry, "test", entry.test_ids, 4);
    this.addField(entry, "relationship", [...entry.module_ids, ...entry.feature_ids], 3);
    this.addField(
      entry,
      "evidence",
      entry.evidence.map((evidence) => evidence.value),
      3
    );
  }

  private addField(entry: L1FileEntry, field: L1SearchField, values: string[], weight: number): void {
    const tokens = new Set(values.flatMap(tokenizeText));

    for (const token of tokens) {
      const postings = this.postingsByToken.get(token) ?? [];
      postings.push({ entryId: entry.id, field, weight });
      this.postingsByToken.set(token, postings);
    }
  }

  private addMatches(
    token: string,
    multiplier: number,
    scoresByEntryId: Map<string, number>,
    reasonsByEntryId: Map<string, Map<string, number>>
  ): void {
    for (const posting of this.postingsByToken.get(token) ?? []) {
      scoresByEntryId.set(posting.entryId, (scoresByEntryId.get(posting.entryId) ?? 0) + posting.weight * multiplier);
      const reasons = reasonsByEntryId.get(posting.entryId) ?? new Map<string, number>();
      const reason = `${formatField(posting.field)} matched ${token}`;
      reasons.set(reason, Math.max(reasons.get(reason) ?? 0, posting.weight * multiplier));
      reasonsByEntryId.set(posting.entryId, reasons);
    }
  }

  private addPrefixMatches(
    token: string,
    scoresByEntryId: Map<string, number>,
    reasonsByEntryId: Map<string, Map<string, number>>
  ): void {
    for (const indexedToken of this.postingsByToken.keys()) {
      if (indexedToken === token || (!indexedToken.startsWith(token) && !token.startsWith(indexedToken))) {
        continue;
      }

      this.addMatches(indexedToken, 0.6, scoresByEntryId, reasonsByEntryId);
    }
  }
}

export function buildL1InMemoryIndex(entries: L1FileEntry[]): L1InMemoryIndex {
  return new L1InMemoryIndex(entries);
}

export async function searchL1Knowledge(
  workspaceRoot: string,
  query: string,
  options: L1SearchOptions = {}
): Promise<L1KnowledgeSearchResult> {
  const status = getKnowledgeStatus(workspaceRoot);

  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` and `topchester kb compile` before searching the knowledge base.");
  }

  const loadResult = await loadL1FileEntries(status.kbPath);
  const index = buildL1InMemoryIndex(loadResult.entries);

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    query,
    entryCount: index.size,
    invalidEntryCount: loadResult.invalidEntryCount,
    matches: index.search(query, options),
  };
}

export async function createL1ContextPack(
  workspaceRoot: string,
  query: string,
  options: L1ContextPackOptions = {}
): Promise<L1ContextPackResult> {
  const limit = options.limit ?? 8;
  const minScore = options.minScore ?? 12;
  const status = getKnowledgeStatus(workspaceRoot);

  if (!status.kbExists || !status.kbIsDirectory) {
    throw new Error("Run `topchester kb init` and `topchester kb compile` before creating a context pack.");
  }

  const loadResult = await loadL1FileEntries(status.kbPath);
  const index = buildL1InMemoryIndex(loadResult.entries);
  const matches = index.search(query, { limit: Math.max(limit * 3, limit) });
  const relevantFiles = matches
    .filter((match) => match.score >= minScore)
    .slice(0, limit)
    .map((match): L1ContextPackFile | undefined => {
      const entry = index.getEntry(match.id);

      if (!entry) {
        return undefined;
      }

      return {
        id: match.id,
        path: match.path,
        score: match.score,
        reasons: match.reasons,
        contentHash: match.contentHash,
        scanStatus: match.scanStatus,
        l1: compactL1Entry(entry),
        fullL1: options.includeFullL1 ? entry : undefined,
      };
    })
    .filter((file): file is L1ContextPackFile => Boolean(file));
  const warnings = relevantFiles.length === 0 ? ["No L1 entries met the context pack score threshold."] : [];

  return {
    workspaceRoot,
    kbPath: status.kbPath,
    query,
    entryCount: index.size,
    invalidEntryCount: loadResult.invalidEntryCount,
    selection: { limit, minScore },
    drift: {
      status: "unchecked",
      warnings: ["L1 context pack includes stored scan statuses; exact file-hash drift check has not run yet."],
    },
    summary: summarizeContextPack(query, relevantFiles),
    warnings,
    relevantFiles,
  };
}

export function formatL1KnowledgeSearchResult(result: L1KnowledgeSearchResult): string[] {
  return [
    "KB search",
    `workspace: ${result.workspaceRoot}`,
    `knowledge folder: ${result.kbPath} [ok]`,
    `query: ${result.query}`,
    `entries indexed: ${result.entryCount}`,
    `invalid L1 entries skipped: ${result.invalidEntryCount}`,
    `matches: ${result.matches.length}`,
    ...(result.matches.length === 0 ? ["state: no L1 matches found"] : [""]),
    ...result.matches.flatMap((match) => [
      `${match.score}\t${match.path}\t${match.scanStatus}\t${match.contentHash}`,
      `  reasons: ${match.reasons.join("; ") || "score match"}`,
      `  summary: ${match.summary}`,
    ]),
    "----",
    `total matches: ${result.matches.length}`,
  ];
}

export function formatL1ContextPackResult(result: L1ContextPackResult): string[] {
  return [
    "KB context",
    `workspace: ${result.workspaceRoot}`,
    `knowledge folder: ${result.kbPath} [ok]`,
    `query: ${result.query}`,
    `entries indexed: ${result.entryCount}`,
    `invalid L1 entries skipped: ${result.invalidEntryCount}`,
    `selection: top ${result.selection.limit}, min score ${result.selection.minScore}`,
    `drift: ${result.drift.status}`,
    `relevant files: ${result.relevantFiles.length}`,
    `summary: ${result.summary}`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
    "",
    ...result.relevantFiles.flatMap((file) => [
      `${file.score}\t${file.path}\t${file.scanStatus}\t${file.contentHash}`,
      `  reasons: ${file.reasons.join("; ") || "score match"}`,
      `  responsibilities: ${(file.l1.responsibilities ?? []).join("; ") || "(none)"}`,
      `  symbols: ${(file.l1.symbols ?? []).map((symbol) => symbol.name).join(", ") || "(none)"}`,
      `  imports: ${(file.l1.imports ?? []).join(", ") || "(none)"}`,
      `  exports: ${(file.l1.exports ?? []).join(", ") || "(none)"}`,
      `  tests: ${(file.l1.test_ids ?? []).join(", ") || "(none)"}`,
    ]),
    "----",
    `total relevant files: ${result.relevantFiles.length}`,
  ];
}

export function formatL1ContextPackForPrompt(result: L1ContextPackResult): string {
  return [
    "Topchester KB context pack:",
    "Use this as orientation only. For task-critical facts, read current source files before editing or making exact claims.",
    JSON.stringify(
      stripEmptyContainers({
        query: result.query,
        summary: result.summary,
        drift: result.drift,
        warnings: result.warnings,
        relevantFiles: result.relevantFiles.map((file) => ({
          id: file.id,
          path: file.path,
          score: file.score,
          reasons: file.reasons,
          contentHash: file.contentHash,
          scanStatus: file.scanStatus,
          l1: {
            summary: file.l1.summary,
            file_role: file.l1.file_role,
            responsibilities: file.l1.responsibilities,
            symbols: file.l1.symbols,
            imports: file.l1.imports,
            exports: file.l1.exports,
            module_ids: file.l1.module_ids,
            feature_ids: file.l1.feature_ids,
            test_ids: file.l1.test_ids,
            declared_test_targets: file.l1.declared_test_targets,
            likely_test_targets: file.l1.likely_test_targets,
            tested_by: file.l1.tested_by,
            confidence: file.l1.confidence,
          },
        })),
      }),
      null,
      2
    ),
  ].join("\n");
}

async function loadL1FileEntries(kbPath: string): Promise<{ entries: L1FileEntry[]; invalidEntryCount: number }> {
  const entryPaths = await listJsonFiles(join(kbPath, "l1-files")).catch((error: unknown) => {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  });
  const entries: L1FileEntry[] = [];
  let invalidEntryCount = 0;

  for (const entryPath of entryPaths) {
    try {
      entries.push(parseL1FileEntry(JSON.parse(await readFile(entryPath, "utf8"))));
    } catch {
      invalidEntryCount += 1;
    }
  }

  return { entries, invalidEntryCount };
}

function summarizeContextPack(query: string, files: L1ContextPackFile[]): string {
  if (files.length === 0) {
    return `No strong L1 matches were found for "${query}".`;
  }

  const paths = files.slice(0, 5).map((file) => file.path);
  return `Likely relevant L1 files for "${query}": ${paths.join(", ")}${files.length > paths.length ? ", ..." : ""}.`;
}

function compactL1Entry(entry: L1FileEntry): L1ContextPackKnowledge {
  const responsibilities = take(entry.responsibilities, 5);
  const symbols = take(entry.symbols, 12).map(compactSymbol);
  const imports = take(entry.imports, 20);
  const exports = take(entry.exports, 20);
  const moduleIds = take(entry.module_ids, 10);
  const featureIds = take(entry.feature_ids, 10);
  const testIds = take(entry.test_ids, 10);
  const declaredTestTargets = take(entry.declared_test_targets, 10);
  const likelyTestTargets = take(entry.likely_test_targets, 10);
  const testedBy = take(entry.tested_by, 10);

  return stripUndefinedProperties({
    file_role: entry.file_role,
    summary: entry.summary,
    responsibilities: nonEmptyArray(responsibilities),
    symbols: nonEmptyArray(symbols),
    imports: nonEmptyArray(imports),
    exports: nonEmptyArray(exports),
    module_ids: nonEmptyArray(moduleIds),
    feature_ids: nonEmptyArray(featureIds),
    test_ids: nonEmptyArray(testIds),
    declared_test_targets: nonEmptyArray(declaredTestTargets),
    likely_test_targets: nonEmptyArray(likelyTestTargets),
    tested_by: nonEmptyArray(testedBy),
    confidence: entry.confidence,
  });
}

function take<T>(items: T[], count: number): T[] {
  return items.slice(0, count);
}

function compactSymbol(
  symbol: L1FileEntry["symbols"][number]
): Pick<L1FileEntry["symbols"][number], "name" | "exported"> & { kind?: string; summary?: string } {
  const compacted = {
    name: symbol.name,
    exported: symbol.exported,
    kind: symbol.kind === "symbol" ? undefined : symbol.kind,
    summary: symbol.summary && !isGenericSymbolSummary(symbol.summary, symbol.name) ? symbol.summary : undefined,
  };

  return compacted.kind || compacted.summary
    ? compacted
    : {
        name: compacted.name,
        exported: compacted.exported,
      };
}

export function stripEmptyContainers(value: unknown): unknown {
  if (Array.isArray(value)) {
    const stripped = value.map(stripEmptyContainers).filter((item) => item !== undefined);
    return stripped.length > 0 ? stripped : undefined;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripEmptyContainers(item)] as const)
      .filter(([, item]) => item !== undefined);

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  return value;
}

function stripUndefinedProperties<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function nonEmptyArray<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function isGenericSymbolSummary(summary: string, name: string): boolean {
  const normalizedSummary = summary.trim().replace(/\s+/g, " ");
  return (
    normalizedSummary === `Symbol named ${name}.` ||
    normalizedSummary === `Symbol named ${name}` ||
    normalizedSummary === name
  );
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function tokenizeQuery(text: string): string[] {
  return [...new Set(tokenizeText(text).filter((token) => !queryStopWords.has(token)))];
}

function tokenizeText(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  const rawTokens = spaced.match(/[a-z0-9_]+/g) ?? [];
  const tokens: string[] = [];

  for (const rawToken of rawTokens) {
    const token = rawToken.replace(/^_+|_+$/g, "");

    if (!token || indexStopWords.has(token)) {
      continue;
    }

    tokens.push(token);

    const singular = singularizeToken(token);
    if (singular !== token) {
      tokens.push(singular);
    }
  }

  return tokens;
}

function singularizeToken(token: string): string {
  if (token.length > 3 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }

  return token;
}

function formatField(field: L1SearchField): string {
  switch (field) {
    case "path":
      return "path";
    case "symbol":
      return "symbol";
    case "export":
      return "export";
    case "responsibility":
      return "responsibility";
    case "summary":
      return "summary";
    case "import":
      return "import";
    case "test":
      return "test";
    case "relationship":
      return "relationship";
    case "evidence":
      return "evidence";
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const indexStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const queryStopWords = new Set([
  ...indexStopWords,
  "error",
  "here",
  "log",
  "see",
  "se",
  "tries",
  "trying",
  "user",
  "when",
]);
