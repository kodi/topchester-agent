import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 40_000;
const GIT_FIELD_SEPARATOR = "\x1f";

export type GitChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "unknown";

export interface GitChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  status: GitChangedFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  timestamp: number;
  subject: string;
  authorName: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  binary: boolean;
  missingGit: boolean;
}

export interface GitRepoInfo {
  available: boolean;
  missingGit: boolean;
  repoRoot: string | null;
  repoRootAbsolute: string | null;
  branch: string | null;
  head: string | null;
  hasHead: boolean;
  message?: string;
}

export interface RunGitOptions {
  cwd: string;
  args: string[];
  pathEnv?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowExitCodeOne?: boolean;
  allowNulOutput?: boolean;
}

export interface ScopedPath {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

export async function runGit(options: RunGitOptions): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const args = ["--no-optional-locks", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...options.args];

  return new Promise((resolveCommand) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: options.pathEnv ?? process.env.PATH ?? "",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        LESS: "-F -X",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 500).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBoundedChunk(stdoutChunks, stdoutBytes, chunk, maxOutputBytes);
      stdoutBytes = appended.bytes;
      truncated = truncated || appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBoundedChunk(stderrChunks, stderrBytes, chunk, Math.min(8_000, maxOutputBytes));
      stderrBytes = appended.bytes;
      truncated = truncated || appended.truncated;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settled = true;
      resolveCommand({
        stdout: "",
        stderr: error.code === "ENOENT" ? "git is not available on PATH.\n" : `${error.message}\n`,
        exitCode: 127,
        timedOut: false,
        truncated: false,
        binary: false,
        missingGit: error.code === "ENOENT",
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      settled = true;
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const binary = !options.allowNulOutput && (containsNul(stdout) || containsNul(stderr));

      resolveCommand({
        stdout: binary ? "" : stdout.toString("utf8"),
        stderr: binary ? "git output contained binary data.\n" : stderr.toString("utf8"),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        truncated,
        binary,
        missingGit: false,
      });
    });
  });
}

export function ensureInsideWorkspace(workspaceRoot: string, path: string): ScopedPath {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("Git path is invalid.");
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, absolutePath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Git path must stay inside the workspace: ${path}`);
  }

  return { workspaceRoot: resolvedWorkspace, absolutePath, relativePath: relativePath || "." };
}

export async function getRepoInfo(workspaceRoot: string, pathEnv?: string): Promise<GitRepoInfo> {
  const workspace = await realpath(resolve(workspaceRoot));
  const root = await runGit({
    cwd: workspace,
    pathEnv,
    args: ["rev-parse", "--show-toplevel"],
    maxOutputBytes: 8_000,
  });

  if (root.missingGit) {
    return {
      available: false,
      missingGit: true,
      repoRoot: null,
      repoRootAbsolute: null,
      branch: null,
      head: null,
      hasHead: false,
      message: "git is not available on PATH.",
    };
  }

  if (root.exitCode !== 0) {
    return {
      available: false,
      missingGit: false,
      repoRoot: null,
      repoRootAbsolute: null,
      branch: null,
      head: null,
      hasHead: false,
      message: "This workspace is not inside a Git repository.",
    };
  }

  const repoRootAbsolute = root.stdout.trim();
  const repoRoot = relative(workspace, repoRootAbsolute) || ".";
  const hasHeadResult = await runGit({
    cwd: workspace,
    pathEnv,
    args: ["rev-parse", "--verify", "HEAD"],
    maxOutputBytes: 8_000,
  });
  const hasHead = hasHeadResult.exitCode === 0;
  const branchResult = await runGit({
    cwd: workspace,
    pathEnv,
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    maxOutputBytes: 8_000,
  });
  const headResult = hasHead
    ? await runGit({ cwd: workspace, pathEnv, args: ["rev-parse", "--short", "HEAD"], maxOutputBytes: 8_000 })
    : undefined;

  return {
    available: true,
    missingGit: false,
    repoRoot,
    repoRootAbsolute,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
    head: headResult?.exitCode === 0 ? headResult.stdout.trim() : null,
    hasHead,
  };
}

export function parsePorcelainStatus(output: string): GitChangedFile[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const indexStatus = entry[0] ?? " ";
      const worktreeStatus = entry[1] ?? " ";
      const path = entry.slice(3);
      const untracked = indexStatus === "?" && worktreeStatus === "?";
      const staged = !untracked && indexStatus !== " ";
      const unstaged = !untracked && worktreeStatus !== " ";

      return {
        path,
        indexStatus,
        worktreeStatus,
        status: classifyStatus(indexStatus, worktreeStatus),
        staged,
        unstaged,
        untracked,
      };
    });
}

export function parseGitLog(output: string): GitCommitSummary[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", timestamp = "0", authorName = "", subject = ""] = line.split(GIT_FIELD_SEPARATOR);

      return {
        sha,
        shortSha,
        timestamp: Number(timestamp),
        authorName,
        subject,
      };
    });
}

export function truncateText(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content);

  if (bytes <= maxBytes) {
    return { content, truncated: false };
  }

  return {
    content: Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
}

export function gitLogPrettyFormat(): string {
  return `%H%x1f%h%x1f%ct%x1f%an%x1f%s`;
}

function classifyStatus(indexStatus: string, worktreeStatus: string): GitChangedFileStatus {
  if (indexStatus === "?" && worktreeStatus === "?") {
    return "untracked";
  }

  if (indexStatus === "U" || worktreeStatus === "U" || (indexStatus === "A" && worktreeStatus === "A")) {
    return "conflicted";
  }

  if (indexStatus === "R") {
    return "renamed";
  }

  if (indexStatus === "C") {
    return "copied";
  }

  if (indexStatus === "D" || worktreeStatus === "D") {
    return "deleted";
  }

  if (indexStatus === "A") {
    return "added";
  }

  if (indexStatus === "M" || worktreeStatus === "M") {
    return "modified";
  }

  return "unknown";
}

function appendBoundedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number
): { bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) {
    return { bytes: currentBytes, truncated: true };
  }

  const remaining = maxBytes - currentBytes;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(slice);

  return {
    bytes: currentBytes + slice.length,
    truncated: chunk.length > remaining,
  };
}

function containsNul(buffer: Buffer): boolean {
  return buffer.includes(0);
}
