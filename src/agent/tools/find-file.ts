import { execFile as execFileNode } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { type Logger } from "pino";
import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const findFileArgsSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional().default("."),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export type FindFileToolArgs = z.infer<typeof findFileArgsSchema>;
export type FindFileToolCall = ToolCall<"find_file", FindFileToolArgs>;
export type FindFileToolResult = ToolResult<"find_file">;

export interface FindWorkspaceFilesByNameOptions {
  pathEnv?: string;
  logger?: Logger;
}

interface FileMatch {
  path: string;
  score: number;
}

const ignoredDirectories = new Set([
  ".git",
  ".agents",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export const findFileTool = defineTool({
  name: "find_file",
  description:
    "Find files by fuzzy name inside the workspace. Results are file paths, not file contents; use read_file next when the user needs contents.",
  prompt:
    'find_file: find existing files by fuzzy path or filename inside the workspace; matches may appear in the middle of a filename, and results are file paths, not file contents. To use it, reply with only JSON: {"tool":"find_file","args":{"query":"runtime"}}',
  argsSchema: findFileArgsSchema,
  execute: (context, args) =>
    findWorkspaceFilesByName(context.workspaceRoot, args, { pathEnv: context.pathEnv, logger: context.logger }),
});

export async function findWorkspaceFilesByName(
  workspaceRoot: string,
  args: FindFileToolArgs,
  options: FindWorkspaceFilesByNameOptions = {}
): Promise<FindFileToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path);
  const files = await collectWorkspaceFiles(
    scopedPath.workspaceRoot,
    scopedPath.path,
    scopedPath.relativePath,
    options
  );
  const matches = files
    .map((path): FileMatch | undefined => {
      const score = scoreFileMatch(args.query, path);

      return score > 0 ? { path, score } : undefined;
    })
    .filter((match): match is FileMatch => Boolean(match))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, args.limit);

  return {
    tool: "find_file",
    path: scopedPath.relativePath,
    content: matches.length > 0 ? matches.map((match) => match.path).join("\n") : "No matching files.",
  };
}

async function collectWorkspaceFiles(
  workspaceRoot: string,
  startPath: string,
  relativeStartPath: string,
  options: FindWorkspaceFilesByNameOptions
): Promise<string[]> {
  const nativeFiles = await collectWorkspaceFilesWithNativeCommand(workspaceRoot, relativeStartPath, options);

  if (nativeFiles) {
    return nativeFiles;
  }

  options.logger?.debug(
    {
      event: "native_tool_selected",
      tool: "find_file",
      nativeTool: "node",
      path: relativeStartPath,
    },
    "native tool selected"
  );

  return collectWorkspaceFilesWithNode(workspaceRoot, startPath);
}

async function collectWorkspaceFilesWithNativeCommand(
  workspaceRoot: string,
  relativeStartPath: string,
  options: FindWorkspaceFilesByNameOptions
): Promise<string[] | undefined> {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const collectors: NativeCollectorFactory[] = [createRipgrepCollector, createFdCollector, createFindCollector];

  for (const createCollector of collectors) {
    const collector = await createCollector(pathEnv, relativeStartPath);

    if (!collector) {
      continue;
    }

    options.logger?.debug(
      {
        event: "native_tool_selected",
        tool: "find_file",
        nativeTool: collector.name,
        path: relativeStartPath,
      },
      "native tool selected"
    );
    const result = await runCommand(collector.command, collector.args, workspaceRoot);
    options.logger?.debug(
      {
        event: "find_file_command_result",
        command: collector.name,
        exitCode: result.exitCode,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      },
      "find_file command result"
    );
    options.logger?.trace(
      {
        event: "find_file_command_output",
        command: collector.name,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      "find_file command output"
    );

    if (result.exitCode === 0) {
      return normalizeCommandFileList(workspaceRoot, result.stdout);
    }
  }

  return undefined;
}

async function collectWorkspaceFilesWithNode(workspaceRoot: string, startPath: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [startPath];

  while (pending.length > 0) {
    const currentPath = pending.pop() ?? startPath;
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = resolve(currentPath, entry.name);
      const relativePath = relative(workspaceRoot, absolutePath);

      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath || ".");
      }
    }
  }

  return files;
}

interface NativeCollector {
  name: string;
  command: string;
  args: string[];
}

type NativeCollectorFactory = (pathEnv: string, relativeStartPath: string) => Promise<NativeCollector | undefined>;

async function createRipgrepCollector(
  pathEnv: string,
  relativeStartPath: string
): Promise<NativeCollector | undefined> {
  const command = await findExecutable("rg", pathEnv);

  if (!command) {
    return undefined;
  }

  return {
    name: "rg",
    command,
    args: ["--files", "--hidden", "--no-ignore", ...ignoredDirectoryGlobArgs(), "--", relativeStartPath],
  };
}

async function createFdCollector(pathEnv: string, relativeStartPath: string): Promise<NativeCollector | undefined> {
  const fdCommand = await findExecutable("fd", pathEnv);
  const fdfindCommand = fdCommand ? undefined : await findExecutable("fdfind", pathEnv);
  const command = fdCommand ?? fdfindCommand;

  if (!command) {
    return undefined;
  }

  return {
    name: fdCommand ? "fd" : "fdfind",
    command,
    args: [
      "--type",
      "f",
      "--hidden",
      "--no-ignore",
      "--color",
      "never",
      ...ignoredDirectoryExcludeArgs(),
      ".",
      relativeStartPath,
    ],
  };
}

async function createFindCollector(pathEnv: string, relativeStartPath: string): Promise<NativeCollector | undefined> {
  const command = await findExecutable("find", pathEnv);

  if (!command) {
    return undefined;
  }

  return {
    name: "find",
    command,
    args: [relativeStartPath, "(", ...ignoredDirectoryFindPruneArgs(), ")", "-prune", "-o", "-type", "f", "-print"],
  };
}

function ignoredDirectoryGlobArgs(): string[] {
  return [...ignoredDirectories].flatMap((directory) => ["--glob", `!${directory}/**`]);
}

function ignoredDirectoryExcludeArgs(): string[] {
  return [...ignoredDirectories].flatMap((directory) => ["--exclude", directory]);
}

function ignoredDirectoryFindPruneArgs(): string[] {
  return [...ignoredDirectories].flatMap((directory, index) =>
    index === 0 ? ["-name", directory] : ["-o", "-name", directory]
  );
}

function normalizeCommandFileList(workspaceRoot: string, stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => normalizeCommandFilePath(workspaceRoot, line))
    .filter((path): path is string => Boolean(path));
}

function normalizeCommandFilePath(workspaceRoot: string, path: string): string | undefined {
  const trimmed = path.trim();

  if (!trimmed) {
    return undefined;
  }

  const relativePath = isAbsolute(trimmed) ? relative(workspaceRoot, trimmed) : trimmed.replace(/^\.\//, "");

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath;
}

function scoreFileMatch(query: string, path: string): number {
  const normalizedQuery = normalize(query);
  const normalizedPath = normalize(path);
  const normalizedName = normalize(basename(path));

  if (!normalizedQuery) {
    return 0;
  }

  const exactScore = scoreExactMatch(normalizedQuery, normalizedPath, normalizedName);
  if (exactScore > 0) {
    return exactScore;
  }

  const pathTokenScore = scoreTokenMatch(normalizedQuery, normalizedPath);
  const nameTokenScore = scoreTokenMatch(normalizedQuery, normalizedName);
  const nameFuzzyScore = scoreSubsequenceMatch(normalizedQuery, normalizedName);
  const pathFuzzyScore = scoreSubsequenceMatch(normalizedQuery, normalizedPath);

  return Math.max(pathTokenScore, nameTokenScore, nameFuzzyScore, pathFuzzyScore);
}

function scoreExactMatch(query: string, path: string, name: string): number {
  if (name === query) {
    return 1000;
  }

  if (path === query) {
    return 950;
  }

  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) {
    return 900 - nameIndex - Math.max(0, name.length - query.length) / 100;
  }

  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) {
    return 800 - pathIndex - Math.max(0, path.length - query.length) / 100;
  }

  return 0;
}

function scoreTokenMatch(query: string, value: string): number {
  const tokens = query.split(/[^a-z0-9]+/).filter(Boolean);

  if (tokens.length <= 1 || !tokens.every((token) => value.includes(token))) {
    return 0;
  }

  return 700 - Math.max(0, value.length - query.length) / 100;
}

function scoreSubsequenceMatch(query: string, value: string): number {
  let queryIndex = 0;
  let gapCount = 0;
  let lastMatchIndex = -1;

  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (lastMatchIndex >= 0) {
      gapCount += valueIndex - lastMatchIndex - 1;
    }

    lastMatchIndex = valueIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) {
    return 0;
  }

  return 600 - gapCount - Math.max(0, value.length - query.length) / 100;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("\\", "/");
}

function resolveWorkspaceScopedPath(workspaceRoot: string, path: string) {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`find_file can only search inside the workspace: ${path}`);
  }

  return {
    workspaceRoot: resolvedWorkspace,
    path: resolvedPath,
    relativePath: relativePath || ".",
  };
}

async function findExecutable(name: string, pathEnv: string): Promise<string | undefined> {
  for (const pathEntry of pathEnv.split(delimiter).filter(Boolean)) {
    const executablePath = join(pathEntry, name);

    try {
      await access(executablePath, constants.X_OK);
      return executablePath;
    } catch {
      continue;
    }
  }

  return undefined;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    execFileNode(command, args, { cwd, maxBuffer: 5_000_000 }, (error, stdout, stderr) => {
      resolveCommand({
        exitCode: getExitCode(error),
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function getExitCode(error: unknown): number {
  if (!error) {
    return 0;
  }

  if (isRecord(error) && typeof error.code === "number") {
    return error.code;
  }

  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
