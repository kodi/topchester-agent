import { createHash } from "node:crypto";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import picomatch from "picomatch";

export interface InventoryFile {
  path: string;
  sizeBytes: number;
  hash: string;
}

export interface InventoryResult {
  workspaceRoot: string;
  gitignoreFiles: string[];
  files: InventoryFile[];
}

export interface InventoryOptions {
  excludedPaths?: string[];
  ignorePaths?: string[];
}

export type ProjectFileInspection =
  | { status: "included"; file: InventoryFile; gitignoreFiles: string[] }
  | {
      status: "skipped";
      path: string;
      reason:
        | "binary"
        | "config_ignore"
        | "default_exclude"
        | "gitignore"
        | "not_file"
        | "outside_workspace"
        | "too_large";
      gitignoreFiles: string[];
    }
  | { status: "missing"; path: string; gitignoreFiles: string[] };

export interface InspectProjectFileOptions extends InventoryOptions {
  maxBytes?: number;
}

interface IgnoreRule {
  baseDir: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

interface ProjectIgnoreRule {
  pattern: string;
  negated: boolean;
  matcher: picomatch.Matcher;
}

export interface ProjectIgnoreMatcher {
  readonly ruleCount: number;
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
  shouldPruneDirectory(relativePath: string): boolean;
}

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".agents/topchester",
  ".agents/topchester-kb-cache",
  "topchester-kb",
]);

const DEFAULT_EXCLUDED_FILES = new Set(["topchester.jsonc"]);

const BINARY_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const BINARY_FILE_NAMES = new Set([".ds_store"]);

const BINARY_SNIFF_BYTES = 4096;
const BINARY_CONTROL_BYTE_RATIO_THRESHOLD = 0.3;

export async function listProjectFilesForL1(
  workspaceRoot: string,
  options: InventoryOptions = {}
): Promise<InventoryResult> {
  const excludedDirs = buildExcludedDirs(workspaceRoot, options.excludedPaths ?? []);
  const rules = await loadGitignoreRules(workspaceRoot, excludedDirs);
  const projectIgnoreMatcher = createProjectIgnoreMatcher(options.ignorePaths ?? []);
  const files: InventoryFile[] = [];

  await walkDirectory(workspaceRoot, workspaceRoot, rules, projectIgnoreMatcher, files, excludedDirs);

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    workspaceRoot,
    gitignoreFiles: rules
      .map((rule) => join(rule.baseDir, ".gitignore"))
      .filter(unique)
      .sort(),
    files,
  };
}

export async function inspectProjectFileForL1(
  workspaceRoot: string,
  relativePath: string,
  options: InspectProjectFileOptions = {}
): Promise<ProjectFileInspection> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const normalizedPath = toPosixPath(relativePath);
  const absolutePath = resolve(resolvedWorkspace, normalizedPath);
  const containedPath = toPosixPath(relative(resolvedWorkspace, absolutePath));
  const excludedDirs = buildExcludedDirs(resolvedWorkspace, options.excludedPaths ?? []);
  const emptyGitignoreFiles: string[] = [];

  if (containedPath.startsWith("../") || containedPath === ".." || isAbsolute(containedPath)) {
    return {
      status: "skipped",
      path: normalizedPath,
      reason: "outside_workspace",
      gitignoreFiles: emptyGitignoreFiles,
    };
  }

  if (shouldSkipFileByDefault(containedPath) || shouldSkipDirectoryByDefault(dirname(containedPath), excludedDirs)) {
    return { status: "skipped", path: containedPath, reason: "default_exclude", gitignoreFiles: emptyGitignoreFiles };
  }

  const rules = await loadGitignoreRulesForPath(resolvedWorkspace, containedPath);
  const gitignoreFiles = rules.map((rule) => join(rule.baseDir, ".gitignore")).filter(unique);

  if (isPathIgnored(resolvedWorkspace, absolutePath, rules, excludedDirs)) {
    return { status: "skipped", path: containedPath, reason: "gitignore", gitignoreFiles };
  }

  const projectIgnoreMatcher = createProjectIgnoreMatcher(options.ignorePaths ?? []);
  if (projectIgnoreMatcher.isIgnored(containedPath, false)) {
    return { status: "skipped", path: containedPath, reason: "config_ignore", gitignoreFiles };
  }

  const fileStat = await stat(absolutePath).catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!fileStat) {
    return { status: "missing", path: containedPath, gitignoreFiles };
  }
  if (!fileStat.isFile()) {
    return { status: "skipped", path: containedPath, reason: "not_file", gitignoreFiles };
  }

  const realWorkspace = await realpath(resolvedWorkspace);
  const realFile = await realpath(absolutePath);
  const realRelativePath = toPosixPath(relative(realWorkspace, realFile));
  if (realRelativePath.startsWith("../") || realRelativePath === ".." || isAbsolute(realRelativePath)) {
    return { status: "skipped", path: containedPath, reason: "outside_workspace", gitignoreFiles };
  }

  if (options.maxBytes !== undefined && fileStat.size > options.maxBytes) {
    return { status: "skipped", path: containedPath, reason: "too_large", gitignoreFiles };
  }
  if (await isBinaryFile(realFile, containedPath)) {
    return { status: "skipped", path: containedPath, reason: "binary", gitignoreFiles };
  }

  return {
    status: "included",
    file: { path: containedPath, sizeBytes: fileStat.size, hash: await hashFile(realFile) },
    gitignoreFiles,
  };
}

function isPathIgnored(
  workspaceRoot: string,
  absolutePath: string,
  rules: IgnoreRule[],
  excludedDirs: Set<string>
): boolean {
  let current = dirname(absolutePath);
  while (current !== workspaceRoot && current.startsWith(`${workspaceRoot}${sep}`)) {
    if (isIgnored(workspaceRoot, current, true, rules, excludedDirs)) return true;
    current = dirname(current);
  }
  return isIgnored(workspaceRoot, absolutePath, false, rules, excludedDirs);
}

async function loadGitignoreRules(workspaceRoot: string, excludedDirs: Set<string>): Promise<IgnoreRule[]> {
  const gitignorePaths: string[] = [];
  await collectGitignorePaths(workspaceRoot, workspaceRoot, gitignorePaths, excludedDirs);

  const rules: IgnoreRule[] = [];
  for (const gitignorePath of gitignorePaths.sort()) {
    const content = await readFile(gitignorePath, "utf8");
    const baseDir = dirname(gitignorePath);
    for (const rawLine of content.split(/\r?\n/)) {
      const rule = parseGitignoreLine(baseDir, rawLine);
      if (rule) {
        rules.push(rule);
      }
    }
  }

  return rules;
}

async function loadGitignoreRulesForPath(workspaceRoot: string, relativePath: string): Promise<IgnoreRule[]> {
  const directoryParts = dirname(relativePath) === "." ? [] : dirname(relativePath).split("/");
  const directories = [workspaceRoot];
  let current = workspaceRoot;
  for (const part of directoryParts) {
    current = join(current, part);
    directories.push(current);
  }

  const rules: IgnoreRule[] = [];
  for (const directory of directories) {
    const gitignorePath = join(directory, ".gitignore");
    const content = await readFile(gitignorePath, "utf8").catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (content === undefined) continue;
    for (const rawLine of content.split(/\r?\n/)) {
      const rule = parseGitignoreLine(directory, rawLine);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

async function collectGitignorePaths(
  workspaceRoot: string,
  dir: string,
  gitignorePaths: string[],
  excludedDirs: Set<string>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = toPosixPath(relative(workspaceRoot, absolutePath));

    if (entry.name === ".gitignore") {
      gitignorePaths.push(absolutePath);
      continue;
    }

    if (!entry.isDirectory() || shouldSkipDirectoryByDefault(relativePath, excludedDirs)) {
      continue;
    }

    await collectGitignorePaths(workspaceRoot, absolutePath, gitignorePaths, excludedDirs);
  }
}

async function walkDirectory(
  workspaceRoot: string,
  dir: string,
  rules: IgnoreRule[],
  projectIgnoreMatcher: ProjectIgnoreMatcher,
  files: InventoryFile[],
  excludedDirs: Set<string>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = toPosixPath(relative(workspaceRoot, absolutePath));

    if (entry.isDirectory()) {
      if (
        !shouldSkipDirectoryByDefault(relativePath, excludedDirs) &&
        !isIgnored(workspaceRoot, absolutePath, true, rules, excludedDirs) &&
        !projectIgnoreMatcher.shouldPruneDirectory(relativePath)
      ) {
        await walkDirectory(workspaceRoot, absolutePath, rules, projectIgnoreMatcher, files, excludedDirs);
      }
      continue;
    }

    if (
      !entry.isFile() ||
      shouldSkipFileByDefault(relativePath) ||
      isIgnored(workspaceRoot, absolutePath, false, rules, excludedDirs) ||
      projectIgnoreMatcher.isIgnored(relativePath, false)
    ) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    if (await isBinaryFile(absolutePath, relativePath)) {
      continue;
    }

    files.push({ path: relativePath, sizeBytes: fileStat.size, hash: await hashFile(absolutePath) });
  }
}

async function isBinaryFile(absolutePath: string, relativePath: string): Promise<boolean> {
  const lowerRelativePath = relativePath.toLowerCase();
  const fileName = lowerRelativePath.split("/").at(-1) ?? lowerRelativePath;

  if (BINARY_FILE_NAMES.has(fileName) || BINARY_FILE_EXTENSIONS.has(extname(lowerRelativePath))) {
    return true;
  }

  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspiciousControlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }

    const isAllowedTextControl =
      byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    if (byte < 32 && !isAllowedTextControl) {
      suspiciousControlBytes += 1;
    }
  }

  return suspiciousControlBytes / buffer.length > BINARY_CONTROL_BYTE_RATIO_THRESHOLD;
}

async function hashFile(absolutePath: string): Promise<string> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const hash = createHash("sha256");
    const stream = fileHandle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await fileHandle.close();
  }
}

function parseGitignoreLine(baseDir: string, rawLine: string): IgnoreRule | undefined {
  let line = rawLine.trim();

  if (!line || line.startsWith("#")) {
    return undefined;
  }

  const negated = line.startsWith("!");
  if (negated) {
    line = line.slice(1);
  }

  if (!line) {
    return undefined;
  }

  const directoryOnly = line.endsWith("/");
  line = line.replace(/^\/+/, "").replace(/\/+$/, "");

  if (!line) {
    return undefined;
  }

  return { baseDir, pattern: line, negated, directoryOnly };
}

function isIgnored(
  workspaceRoot: string,
  absolutePath: string,
  isDirectory: boolean,
  rules: IgnoreRule[],
  excludedDirs: Set<string>
): boolean {
  let ignored = false;

  for (const rule of rules) {
    const relativeToRule = toPosixPath(relative(rule.baseDir, absolutePath));
    if (relativeToRule.startsWith("../") || relativeToRule === "..") {
      continue;
    }
    if (rule.directoryOnly && !isDirectory) {
      continue;
    }
    if (matchesRule(relativeToRule, rule.pattern)) {
      ignored = !rule.negated;
    }
  }

  if (ignored) {
    return true;
  }

  const workspaceRelativePath = toPosixPath(relative(workspaceRoot, absolutePath));
  return shouldSkipDirectoryByDefault(workspaceRelativePath, excludedDirs) && isDirectory;
}

function matchesRule(relativePath: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    return matchGlob(relativePath, pattern) || relativePath.startsWith(`${pattern}/`);
  }

  return relativePath.split("/").some((part) => matchGlob(part, pattern));
}

function matchGlob(value: string, pattern: string): boolean {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const nextChar = pattern[index + 1];

    if (char === "*" && nextChar === "*") {
      regex += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegexChar(char);
  }

  regex += "$";

  return new RegExp(regex).test(value);
}

function escapeRegexChar(value: string): string {
  return /[.+^${}()|[\]\\]/.test(value) ? `\\${value}` : value;
}

function shouldSkipDirectoryByDefault(
  relativePath: string,
  excludedDirs: Set<string> = DEFAULT_EXCLUDED_DIRS
): boolean {
  return excludedDirs.has(relativePath) || [...excludedDirs].some((dir) => relativePath.startsWith(`${dir}/`));
}

function shouldSkipFileByDefault(relativePath: string): boolean {
  return DEFAULT_EXCLUDED_FILES.has(relativePath);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function unique(value: string, index: number, array: string[]): boolean {
  return array.indexOf(value) === index;
}

function buildExcludedDirs(workspaceRoot: string, excludedPaths: string[]): Set<string> {
  const dirs = new Set(DEFAULT_EXCLUDED_DIRS);

  for (const excludedPath of excludedPaths) {
    const workspaceRelativePath = toPosixPath(relative(workspaceRoot, excludedPath));
    if (!workspaceRelativePath || workspaceRelativePath === "." || workspaceRelativePath.startsWith("../")) {
      continue;
    }
    dirs.add(workspaceRelativePath);
  }

  return dirs;
}

export function createProjectIgnoreMatcher(ignorePaths: string[]): ProjectIgnoreMatcher {
  const rules = ignorePaths.map(createProjectIgnoreRule);

  return {
    ruleCount: rules.length,
    isIgnored(relativePath: string, isDirectory: boolean): boolean {
      return isProjectIgnored(normalizeProjectPath(relativePath), isDirectory, rules);
    },
    shouldPruneDirectory(relativePath: string): boolean {
      const normalizedPath = normalizeProjectPath(relativePath);
      return (
        isProjectIgnored(normalizedPath, true, rules) &&
        !rules.some((rule) => rule.negated && canRuleMatchDescendant(rule.pattern, normalizedPath))
      );
    },
  };
}

function createProjectIgnoreRule(rawPattern: string): ProjectIgnoreRule {
  const negated = rawPattern.startsWith("!");
  const rawPatternBody = negated ? rawPattern.slice(1) : rawPattern;
  const pattern = normalizeProjectPath(rawPatternBody);

  if (
    !pattern ||
    pattern === "." ||
    rawPatternBody.startsWith("/") ||
    isAbsolute(rawPatternBody) ||
    win32.isAbsolute(rawPatternBody) ||
    pattern.split("/").includes("..")
  ) {
    throw new Error(`Invalid Topchester ignore path rule: ${rawPattern}`);
  }

  return {
    pattern,
    negated,
    matcher: picomatch(pattern, { dot: true, nonegate: true }),
  };
}

function isProjectIgnored(relativePath: string, isDirectory: boolean, rules: ProjectIgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (matchesProjectIgnoreRule(rule, relativePath, isDirectory)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function matchesProjectIgnoreRule(rule: ProjectIgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.matcher(relativePath)) {
    return true;
  }

  const globstarPrefix = rule.pattern.endsWith("/**") ? rule.pattern.slice(0, -3) : undefined;
  if (globstarPrefix && (relativePath === globstarPrefix || relativePath.startsWith(`${globstarPrefix}/`))) {
    return true;
  }

  if (!hasGlobToken(rule.pattern) && relativePath.startsWith(`${rule.pattern}/`)) {
    return true;
  }

  return isDirectory && rule.matcher(`${relativePath}/`);
}

function canRuleMatchDescendant(pattern: string, directoryPath: string): boolean {
  return pattern === directoryPath || pattern.startsWith(`${directoryPath}/`);
}

function hasGlobToken(pattern: string): boolean {
  return /[*?[\]{}()]/.test(pattern);
}

function normalizeProjectPath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
