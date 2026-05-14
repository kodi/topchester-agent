import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseL1FileEntry, type L1FileEntry, type L1FileRole } from "./l1-entry.js";

export interface L1PostProcessSummary {
  entriesRead: number;
  entriesUpdated: number;
  testLinksAdded: number;
}

export async function postProcessL1Entries(kbPath: string): Promise<L1PostProcessSummary> {
  const entries = await loadL1Entries(kbPath);
  const entriesById = new Map(entries.map(({ entry }) => [entry.id, entry]));
  const entriesByPath = new Map(entries.map(({ entry }) => [entry.path, entry]));
  const testTargetsById = new Map<string, { declared: string[]; likely: string[] }>();

  for (const { entry } of entries) {
    const fileRole = inferL1FileRole(entry.path);

    if (fileRole !== "test") {
      testTargetsById.set(entry.id, { declared: [], likely: [] });
      continue;
    }

    const declared = dedupeStrings([
      ...entry.declared_test_targets.filter((id) => isExistingNonSelfFileId(id, entry.id, entriesById)),
      ...entry.imports.filter((id) => isExistingNonSelfFileId(id, entry.id, entriesById)),
    ]);
    const likely = dedupeStrings([
      ...entry.likely_test_targets.filter((id) => isExistingNonSelfFileId(id, entry.id, entriesById)),
      ...inferLikelyTestTargets(entry.path, entriesByPath),
    ]);

    testTargetsById.set(entry.id, { declared, likely });
  }

  const testedBy = new Map<string, string[]>();
  for (const [testId, links] of testTargetsById) {
    for (const targetId of dedupeStrings([...links.declared, ...links.likely])) {
      const list = testedBy.get(targetId) ?? [];
      list.push(testId);
      testedBy.set(targetId, list);
    }
  }

  let entriesUpdated = 0;
  let testLinksAdded = 0;

  for (const { entry, entryPath } of entries) {
    const fileRole = inferL1FileRole(entry.path);
    const links = testTargetsById.get(entry.id) ?? { declared: [], likely: [] };
    const nextEntry = parseL1FileEntry({
      ...entry,
      file_role: fileRole,
      declared_test_targets: links.declared,
      likely_test_targets: links.likely,
      tested_by: dedupeStrings(testedBy.get(entry.id) ?? []).sort(),
    });

    testLinksAdded +=
      nextEntry.declared_test_targets.length + nextEntry.likely_test_targets.length + nextEntry.tested_by.length;

    if (JSON.stringify(nextEntry) !== JSON.stringify(entry)) {
      await writeFile(entryPath, `${JSON.stringify(nextEntry, null, 2)}\n`);
      entriesUpdated += 1;
    }
  }

  return { entriesRead: entries.length, entriesUpdated, testLinksAdded };
}

export function inferL1FileRole(path: string): L1FileRole {
  const lowerPath = path.toLowerCase();
  const name = basename(lowerPath);

  if (isTestPath(lowerPath)) {
    return "test";
  }

  if (lowerPath.startsWith("scripts/") || lowerPath.startsWith("script/") || lowerPath.endsWith(".sh")) {
    return "script";
  }

  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx") || lowerPath.startsWith("docs/")) {
    return "doc";
  }

  if (
    name === "package.json" ||
    name.endsWith("lock.json") ||
    name.endsWith("-lock.yaml") ||
    name.endsWith(".config.ts") ||
    name.endsWith(".config.js") ||
    name.endsWith(".config.mjs") ||
    name.endsWith(".config.cjs") ||
    name === "tsconfig.json" ||
    name.startsWith(".")
  ) {
    return "config";
  }

  if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(lowerPath)) {
    return "source";
  }

  return "unknown";
}

async function loadL1Entries(kbPath: string): Promise<Array<{ entryPath: string; entry: L1FileEntry }>> {
  const entryPaths = await listJsonFiles(join(kbPath, "l1-files")).catch((error: unknown) => {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  });
  const entries: Array<{ entryPath: string; entry: L1FileEntry }> = [];

  for (const entryPath of entryPaths) {
    entries.push({ entryPath, entry: parseL1FileEntry(JSON.parse(await readFile(entryPath, "utf8"))) });
  }

  return entries.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
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

function inferLikelyTestTargets(testPath: string, entriesByPath: Map<string, L1FileEntry>): string[] {
  const candidates = new Set<string>();
  const sourceLikePath = removeTestSuffix(testPath);

  candidates.add(sourceLikePath);

  for (const prefix of ["test/", "tests/", "__tests__/"]) {
    if (testPath.startsWith(prefix)) {
      candidates.add(`src/${removeTestSuffix(testPath.slice(prefix.length))}`);
    }
  }

  if (testPath.includes("/__tests__/")) {
    candidates.add(removeTestSuffix(testPath.replace("/__tests__/", "/")));
  }

  return [...candidates]
    .filter((candidate) => candidate !== testPath)
    .flatMap((candidate) => {
      const entry = entriesByPath.get(candidate);
      return entry ? [entry.id] : [];
    });
}

function removeTestSuffix(path: string): string {
  return path.replace(/\.(test|spec)(\.[^./]+)$/i, "$2");
}

function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(path) ||
    path.startsWith("test/") ||
    path.startsWith("tests/") ||
    path.startsWith("__tests__/") ||
    path.includes("/__tests__/")
  );
}

function isExistingNonSelfFileId(id: string, selfId: string, entriesById: Map<string, L1FileEntry>): boolean {
  return id !== selfId && entriesById.has(id);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
