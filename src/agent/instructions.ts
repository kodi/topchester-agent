import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type Logger } from "pino";

export const PROJECT_INSTRUCTION_FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
export const DEFAULT_PROJECT_INSTRUCTION_MAX_BYTES_PER_FILE = 32 * 1024;
export const DEFAULT_PROJECT_INSTRUCTION_MAX_TOTAL_BYTES = 96 * 1024;

export interface ProjectInstructionSource {
  path: string;
  relativePath: string;
  scopePath: string;
  depth: number;
  bytes: number;
  truncated: boolean;
  content: string;
}

export interface ProjectInstructionContext {
  sources: ProjectInstructionSource[];
  formatted: string;
  sourceKeys: string[];
  truncated: boolean;
}

export interface ResolveProjectInstructionsOptions {
  targetPath?: string;
  targetIsDirectory?: boolean;
  enabled?: boolean;
  files?: readonly string[];
  fallbackFiles?: readonly string[];
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  logger?: Logger;
}

interface CandidateReadResult {
  absolutePath: string;
  relativePath: string;
  content: string;
  bytes: number;
}

export async function resolveProjectInstructions(
  workspaceRoot: string,
  options: ResolveProjectInstructionsOptions = {}
): Promise<ProjectInstructionContext> {
  const filenames = getProjectInstructionFilenames(options);

  if (filenames.length === 0) {
    return {
      sources: [],
      formatted: "",
      sourceKeys: [],
      truncated: false,
    };
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const targetDirectory = resolveInstructionTargetDirectory(resolvedWorkspace, options);
  const directories = getInstructionDirectories(resolvedWorkspace, targetDirectory);
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_PROJECT_INSTRUCTION_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_PROJECT_INSTRUCTION_MAX_TOTAL_BYTES;
  const sources: ProjectInstructionSource[] = [];
  let remainingBytes = Math.max(0, maxTotalBytes);

  for (const directory of directories) {
    const candidate = await readFirstInstructionCandidate(resolvedWorkspace, directory, filenames, options.logger);

    if (!candidate) {
      continue;
    }

    const scopedContentLimit = Math.min(Math.max(0, maxBytesPerFile), remainingBytes);
    const content = truncateUtf8(candidate.content, scopedContentLimit);
    const truncated = content !== candidate.content;
    remainingBytes -= Buffer.byteLength(content, "utf8");

    sources.push({
      path: candidate.absolutePath,
      relativePath: candidate.relativePath,
      scopePath: formatScopePath(relative(resolvedWorkspace, directory)),
      depth: getScopeDepth(relative(resolvedWorkspace, directory)),
      bytes: candidate.bytes,
      truncated,
      content,
    });
  }

  options.logger?.debug(
    {
      event: "project_instructions_resolved",
      targetPath: options.targetPath,
      sourceCount: sources.length,
      sources: sources.map((source) => ({
        path: source.relativePath,
        scopePath: source.scopePath,
        bytes: source.bytes,
        truncated: source.truncated,
      })),
      truncated: sources.some((source) => source.truncated),
    },
    "project instructions resolved"
  );

  return {
    sources,
    formatted: formatProjectInstructions(sources),
    sourceKeys: sources.map((source) => source.relativePath),
    truncated: sources.some((source) => source.truncated),
  };
}

export function formatProjectInstructions(sources: readonly ProjectInstructionSource[]): string {
  if (sources.length === 0) {
    return "";
  }

  const blocks = sources.map((source) => {
    const filename = basename(source.relativePath);
    const truncationLine = source.truncated
      ? `\n\n[Instruction file truncated to fit Topchester's project-instruction byte budget.]`
      : "";

    return [
      `## ${filename} for ${source.scopePath}`,
      `Scope: ${source.scopePath}`,
      "",
      "<INSTRUCTIONS>",
      `${source.content}${truncationLine}`,
      "</INSTRUCTIONS>",
    ].join("\n");
  });

  return [
    "# AGENTS.md instructions",
    "",
    "Direct system, developer, and user instructions override these files.",
    "For file work, apply every listed file whose scope contains the target path.",
    "When two instruction files conflict, the deeper scope wins for files inside that deeper scope.",
    "",
    ...blocks,
  ].join("\n\n");
}

export function isProjectInstructionPath(workspaceRoot: string, path: string): boolean {
  return isConfiguredProjectInstructionPath(workspaceRoot, path);
}

export function isConfiguredProjectInstructionPath(
  workspaceRoot: string,
  path: string,
  options: Pick<ResolveProjectInstructionsOptions, "enabled" | "files" | "fallbackFiles"> = {}
): boolean {
  const filenames = getProjectInstructionFilenames(options);

  if (filenames.length === 0) {
    return false;
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (!isInsideWorkspaceRelativePath(relativePath)) {
    return false;
  }

  return filenames.includes(basename(relativePath));
}

export function getProjectInstructionFilenames(
  options: Pick<ResolveProjectInstructionsOptions, "enabled" | "files" | "fallbackFiles"> = {}
): string[] {
  if (options.enabled === false) {
    return [];
  }

  const primary = options.files ?? PROJECT_INSTRUCTION_FILENAMES;
  const fallback = options.fallbackFiles ?? [];
  const seen = new Set<string>();
  const filenames: string[] = [];

  for (const filename of [...primary, ...fallback]) {
    if (seen.has(filename)) {
      continue;
    }

    seen.add(filename);
    filenames.push(filename);
  }

  return filenames;
}

function resolveInstructionTargetDirectory(
  resolvedWorkspace: string,
  options: ResolveProjectInstructionsOptions
): string {
  if (!options.targetPath) {
    return resolvedWorkspace;
  }

  const resolvedTarget = isAbsolute(options.targetPath)
    ? resolve(options.targetPath)
    : resolve(resolvedWorkspace, options.targetPath);
  const relativeTarget = relative(resolvedWorkspace, resolvedTarget);

  if (!isInsideWorkspaceRelativePath(relativeTarget)) {
    throw new Error(`Project instructions can only be resolved for paths inside the workspace: ${options.targetPath}`);
  }

  return options.targetIsDirectory ? resolvedTarget : dirname(resolvedTarget);
}

function getInstructionDirectories(resolvedWorkspace: string, targetDirectory: string): string[] {
  const relativeDirectory = relative(resolvedWorkspace, targetDirectory);

  if (!isInsideWorkspaceRelativePath(relativeDirectory)) {
    throw new Error(
      `Project instructions can only be resolved for directories inside the workspace: ${targetDirectory}`
    );
  }

  if (!relativeDirectory) {
    return [resolvedWorkspace];
  }

  const segments = relativeDirectory.split(sep).filter(Boolean);
  const directories = [resolvedWorkspace];
  let current = resolvedWorkspace;

  for (const segment of segments) {
    current = resolve(current, segment);
    directories.push(current);
  }

  return directories;
}

async function readFirstInstructionCandidate(
  resolvedWorkspace: string,
  directory: string,
  filenames: readonly string[],
  logger?: Logger
): Promise<CandidateReadResult | undefined> {
  for (const filename of filenames) {
    const absolutePath = resolve(directory, filename);
    const relativePath = formatRelativePath(relative(resolvedWorkspace, absolutePath));

    try {
      const fileStat = await stat(absolutePath);

      if (!fileStat.isFile()) {
        logger?.debug(
          { event: "project_instruction_skipped", path: relativePath, reason: "not_file" },
          "project instruction skipped"
        );
        continue;
      }

      const bytes = await readFile(absolutePath);
      const content = bytes.toString("utf8");

      if (content.trim().length === 0) {
        logger?.debug(
          { event: "project_instruction_skipped", path: relativePath, reason: "empty" },
          "project instruction skipped"
        );
        continue;
      }

      return {
        absolutePath,
        relativePath,
        content,
        bytes: bytes.byteLength,
      };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;

      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }

      logger?.debug(
        { event: "project_instruction_skipped", path: relativePath, reason: "unreadable", err: error },
        "project instruction skipped"
      );
    }
  }

  return undefined;
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }

  let truncated = "";
  let bytes = 0;

  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");

    if (bytes + charBytes > maxBytes) {
      break;
    }

    truncated += char;
    bytes += charBytes;
  }

  return truncated;
}

function getScopeDepth(relativeScope: string): number {
  const scope = formatScopePath(relativeScope);

  if (scope === ".") {
    return 0;
  }

  return scope.split("/").length;
}

function formatScopePath(relativeScope: string): string {
  return formatRelativePath(relativeScope) || ".";
}

function formatRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function isInsideWorkspaceRelativePath(relativePath: string): boolean {
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
