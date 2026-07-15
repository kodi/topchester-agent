import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import { parseJsonc } from "../../config/index.js";
import { knowledgeCompilerIdentity } from "../compiler/manifest.js";
import { l1FileEntrySchemaPath, parseL1FileEntry, type L1FileEntry } from "../compiler/l1-entry.js";
import { getL1FileEntryPath } from "../compiler/path-encoding.js";
import { parseProductKnowledgeManifest, type ProductKnowledgeManifest } from "./manifest.js";

export interface ProductPackSpec {
  id: "topchester";
  include: string[];
  exclude: string[];
}

export interface ProductPackCheckResult {
  manifest: ProductKnowledgeManifest;
  sourcePaths: string[];
  entryPaths: string[];
  bytes: number;
}

export async function buildTopchesterProductPack(workspaceRoot: string): Promise<ProductPackCheckResult> {
  const root = resolve(workspaceRoot);
  const specPath = join(root, "knowledge", "topchester-pack.jsonc");
  const specText = await readFile(specPath, "utf8");
  const spec = parseProductPackSpec(specText);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  const productVersion = requireString(packageJson.version, "package.json version");
  const sourceFiles = await collectProductSourceFiles(root, spec);
  const generatedAt = new Date().toISOString();
  const stagingParent = join(root, ".agents");
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(stagingParent, "topchester-product-pack-"));
  const stagingOutput = join(stagingRoot, "topchester");

  try {
    for (const source of sourceFiles) {
      const content = await readFile(join(root, source.path), "utf8");
      const entry = createDeterministicProductEntry(source.path, content, source.contentHash, generatedAt);
      const entryPath = getL1FileEntryPath(stagingOutput, source.path);
      await mkdir(dirname(entryPath), { recursive: true });
      await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    }

    const manifest: ProductKnowledgeManifest = {
      formatVersion: 1,
      sourceId: "topchester",
      sourceKind: "builtin-product",
      productVersion,
      compiler: knowledgeCompilerIdentity,
      generatedAt,
      packSpecHash: hashText(specText),
      sourceFileCount: sourceFiles.length,
      entryCount: sourceFiles.length,
      sourceFiles,
    };
    parseProductKnowledgeManifest(manifest);
    await mkdir(stagingOutput, { recursive: true });
    await writeFile(join(stagingOutput, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await checkTopchesterProductPack(root, stagingOutput);
    await replaceDirectory(stagingOutput, join(root, "resources", "knowledge", "topchester"));
    return checkTopchesterProductPack(root);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function checkTopchesterProductPack(
  workspaceRoot: string,
  outputPath = join(resolve(workspaceRoot), "resources", "knowledge", "topchester")
): Promise<ProductPackCheckResult> {
  const root = resolve(workspaceRoot);
  const specPath = join(root, "knowledge", "topchester-pack.jsonc");
  const specText = await readFile(specPath, "utf8");
  const spec = parseProductPackSpec(specText);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
  const productVersion = requireString(packageJson.version, "package.json version");
  const manifest = parseProductKnowledgeManifest(JSON.parse(await readFile(join(outputPath, "manifest.json"), "utf8")));
  const sourceFiles = await collectProductSourceFiles(root, spec);

  assertEqual(manifest.productVersion, productVersion, "Product pack version does not match package.json");
  assertEqual(manifest.packSpecHash, hashText(specText), "Product pack specification changed; regenerate the pack");
  assertEqual(manifest.compiler.name, knowledgeCompilerIdentity.name, "Product pack compiler name is unsupported");
  assertEqual(
    manifest.compiler.version,
    knowledgeCompilerIdentity.version,
    "Product pack compiler version is unsupported"
  );
  assertEqual(manifest.sourceFileCount, sourceFiles.length, "Product pack source file count is stale");
  assertEqual(manifest.entryCount, sourceFiles.length, "Product pack entry count is stale");
  assertEqual(
    JSON.stringify(manifest.sourceFiles),
    JSON.stringify(sourceFiles),
    "Product pack source hashes are stale"
  );

  const entryPaths = await listJsonFiles(join(outputPath, "l1-files"));
  assertEqual(entryPaths.length, manifest.entryCount, "Product pack L1 entry count does not match the manifest");
  let bytes = Buffer.byteLength(JSON.stringify(manifest));
  const allowedPaths = new Set(sourceFiles.map((file) => file.path));

  for (const entryPath of entryPaths) {
    const text = await readFile(entryPath, "utf8");
    const entry = parseL1FileEntry(JSON.parse(text));
    if (!allowedPaths.has(entry.path)) {
      throw new Error(`Product pack entry is not allowed by the specification: ${entry.path}`);
    }
    const source = sourceFiles.find((file) => file.path === entry.path);
    assertEqual(entry.content_hash, source?.contentHash, `Product pack entry hash is stale: ${entry.path}`);
    bytes += Buffer.byteLength(text);
  }

  const serialized = JSON.stringify(manifest);
  if (serialized.includes(`${root}/`) || serialized.includes("workspaceRoot") || serialized.includes("queuePath")) {
    throw new Error("Product manifest contains machine-local workspace data.");
  }

  return { manifest, sourcePaths: sourceFiles.map((file) => file.path), entryPaths, bytes };
}

export function parseProductPackSpec(text: string): ProductPackSpec {
  const value = parseJsonc(text) as Partial<ProductPackSpec>;
  if (value.id !== "topchester" || !isStringArray(value.include) || !isStringArray(value.exclude)) {
    throw new Error("Invalid knowledge/topchester-pack.jsonc product pack specification.");
  }
  return { id: value.id, include: value.include, exclude: value.exclude };
}

async function collectProductSourceFiles(
  root: string,
  spec: ProductPackSpec
): Promise<Array<{ path: string; contentHash: string }>> {
  const paths = await listFiles(root);
  const included = (path: string) => spec.include.some((pattern) => picomatch.isMatch(path, pattern));
  const excluded = (path: string) => spec.exclude.some((pattern) => picomatch.isMatch(path, pattern));

  return Promise.all(
    paths
      .filter((path) => included(path) && !excluded(path))
      .sort()
      .map(async (path) => ({ path, contentHash: hashText(await readFile(join(root, path), "utf8")) }))
  );
}

async function listFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  const skipped = new Set([".git", ".agents", "node_modules", "dist", "topchester-kb"]);
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && skipped.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return paths;
}

function createDeterministicProductEntry(
  path: string,
  content: string,
  contentHash: string,
  generatedAt: string
): L1FileEntry {
  const title = /^---[\s\S]*?\ntitle:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const description = /^---[\s\S]*?\ndescription:\s*(.+)$/m.exec(content)?.[1]?.trim();
  const firstParagraph = content
    .replace(/^---[\s\S]*?---\s*/u, "")
    .split(/\n\s*\n/u)
    .map((part) =>
      part
        .replace(/^#+\s*/u, "")
        .replace(/\s+/gu, " ")
        .trim()
    )
    .find((part) => part && !part.startsWith("```"));
  const summary = (description ?? firstParagraph ?? title ?? `Topchester product guidance from ${path}.`).slice(0, 500);
  const headings = [...content.matchAll(/^##+\s+(.+)$/gm)].map((match) => match[1]!.trim()).slice(0, 6);
  const extension = extname(path).toLowerCase();

  return parseL1FileEntry({
    $schema: l1FileEntrySchemaPath,
    id: `file:${path}`,
    layer: "L1",
    type: "file",
    path,
    language: extension === ".md" ? "markdown" : extension === ".json" || extension === ".jsonc" ? "json" : "text",
    content_hash: contentHash,
    size_bytes: Buffer.byteLength(content),
    last_scanned_at: generatedAt,
    scan_status: "current",
    file_role: path.startsWith("docs/") || path.includes("/references/") ? "doc" : "config",
    summary,
    responsibilities: headings,
    symbols: [],
    imports: [],
    exports: [],
    module_ids: [],
    feature_ids: [],
    test_ids: [],
    declared_test_targets: [],
    likely_test_targets: [],
    tested_by: [],
    evidence: [{ kind: "path", value: path }],
    confidence: "high",
  });
}

async function replaceDirectory(staged: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const backup = `${destination}.previous`;
  await rm(backup, { recursive: true, force: true });
  const destinationExists = await stat(destination)
    .then(() => true)
    .catch(() => false);
  if (destinationExists) await rename(destination, backup);
  try {
    await rename(staged, destination);
  } catch (error) {
    if (destinationExists) await rename(backup, destination);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

async function listJsonFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
    }
  }
  await visit(root);
  return paths.sort();
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}.`);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`);
}
