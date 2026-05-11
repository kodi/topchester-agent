import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";

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
}

interface IgnoreRule {
  baseDir: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
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
  const files: InventoryFile[] = [];

  await walkDirectory(workspaceRoot, workspaceRoot, rules, files, excludedDirs);

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
        !isIgnored(workspaceRoot, absolutePath, true, rules, excludedDirs)
      ) {
        await walkDirectory(workspaceRoot, absolutePath, rules, files, excludedDirs);
      }
      continue;
    }

    if (!entry.isFile() || isIgnored(workspaceRoot, absolutePath, false, rules, excludedDirs)) {
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
