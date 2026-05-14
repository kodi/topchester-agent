import { z } from "zod";
import {
  ensureInsideWorkspace,
  getRepoInfo,
  gitLogPrettyFormat,
  parseGitLog,
  parsePorcelainStatus,
  runGit,
  truncateText,
  type GitChangedFile,
  type GitCommitSummary,
  type GitRepoInfo,
} from "./git-runner.js";
import { defineTool, type ToolCall, type ToolContext, type ToolResult } from "./types.js";

const gitStatusValueSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "unknown",
]);

export const gitStatusArgsSchema = z.object({
  path: z.string().optional().default("."),
  include_untracked: z.boolean().optional().default(true),
});

export const gitDiffArgsSchema = z.object({
  scope: z.enum(["all", "unstaged", "staged"]).optional().default("all"),
  path: z.string().optional(),
  include_untracked: z.boolean().optional().default(false),
  context_lines: z.number().int().min(0).max(20).optional().default(3),
  max_bytes: z.number().int().min(1_000).max(200_000).optional().default(40_000),
});

export const gitLogArgsSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(10),
  path: z.string().optional(),
});

export const gitAddArgsSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  expected_status: z.array(z.object({ path: z.string().min(1), status: gitStatusValueSchema })).min(1),
});

export const gitCommitArgsSchema = z.object({
  message: z.string().trim().min(1).max(500),
  expected_staged_paths: z.array(z.string().min(1)).min(1),
});

export type GitStatusToolArgs = z.infer<typeof gitStatusArgsSchema>;
export type GitDiffToolArgs = z.infer<typeof gitDiffArgsSchema>;
export type GitLogToolArgs = z.infer<typeof gitLogArgsSchema>;
export type GitAddToolArgs = z.infer<typeof gitAddArgsSchema>;
export type GitCommitToolArgs = z.infer<typeof gitCommitArgsSchema>;

export type GitStatusToolCall = ToolCall<"git_status", GitStatusToolArgs>;
export type GitDiffToolCall = ToolCall<"git_diff", GitDiffToolArgs>;
export type GitLogToolCall = ToolCall<"git_log", GitLogToolArgs>;
export type GitAddToolCall = ToolCall<"git_add", GitAddToolArgs>;
export type GitCommitToolCall = ToolCall<"git_commit", GitCommitToolArgs>;

export interface GitStatusToolResult extends ToolResult<"git_status"> {
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  hasHead: boolean;
  clean: boolean;
  files: GitChangedFile[];
  truncated: boolean;
}

export interface GitDiffToolResult extends ToolResult<"git_diff"> {
  repoRoot: string | null;
  scope: "all" | "unstaged" | "staged";
  path?: string;
  fileCount: number;
  truncated: boolean;
}

export interface GitLogToolResult extends ToolResult<"git_log"> {
  repoRoot: string | null;
  commits: GitCommitSummary[];
  truncated: boolean;
}

export interface GitAddToolResult extends ToolResult<"git_add"> {
  repoRoot: string | null;
  stagedPaths: string[];
  files: GitChangedFile[];
}

export interface GitCommitToolResult extends ToolResult<"git_commit"> {
  repoRoot: string | null;
  commit: GitCommitSummary;
  stagedPaths: string[];
  remainingFiles: GitChangedFile[];
  stat: string;
  nameStatus: string;
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description: "Inspect structured Git branch and changed-file status inside the workspace.",
  prompt:
    'git_status: inspect branch, head, clean state, staged, unstaged, and untracked files without parsing shell output. To use it, reply with only JSON: {"tool":"git_status","args":{"path":".","include_untracked":true}}',
  argsSchema: gitStatusArgsSchema,
  execute: (context, args) => inspectGitStatus(context, args),
});

export const gitDiffTool = defineTool({
  name: "git_diff",
  description: "Inspect bounded Git diffs for staged, unstaged, and optionally untracked files.",
  prompt:
    'git_diff: inspect a bounded Git diff; use scope "all", "unstaged", or "staged", and include_untracked:true only when untracked file patches are needed. To use it, reply with only JSON: {"tool":"git_diff","args":{"scope":"all","include_untracked":true}}',
  argsSchema: gitDiffArgsSchema,
  execute: (context, args) => inspectGitDiff(context, args),
});

export const gitLogTool = defineTool({
  name: "git_log",
  description: "Inspect recent Git commits as bounded structured summaries.",
  prompt:
    'git_log: inspect recent commits without parsing shell output. To use it, reply with only JSON: {"tool":"git_log","args":{"limit":10,"path":"src/agent/runtime.ts"}}',
  argsSchema: gitLogArgsSchema,
  execute: (context, args) => inspectGitLog(context, args),
});

export const gitAddTool = defineTool({
  name: "git_add",
  description: "Stage explicit changed paths after current Git status has been inspected.",
  prompt:
    'git_add: stage only explicit paths the user asked to stage; first inspect git_status, reject broad paths, and pass expected_status for each path. To use it, reply with only JSON: {"tool":"git_add","args":{"paths":["src/example.ts"],"expected_status":[{"path":"src/example.ts","status":"modified"}]}}',
  argsSchema: gitAddArgsSchema,
  execute: (context, args) => stageGitPaths(context, args),
});

export const gitCommitTool = defineTool({
  name: "git_commit",
  description: "Create a Git commit from exactly the expected staged paths.",
  prompt:
    'git_commit: commit only after the user explicitly asks and staged paths exactly match expected_staged_paths. To use it, reply with only JSON: {"tool":"git_commit","args":{"message":"Add feature","expected_staged_paths":["src/example.ts"]}}',
  argsSchema: gitCommitArgsSchema,
  execute: (context, args) => commitGitPaths(context, args),
});

async function inspectGitStatus(context: ToolContext, args: GitStatusToolArgs): Promise<GitStatusToolResult> {
  const repo = await getRepoInfo(context.workspaceRoot, context.pathEnv);
  const unavailable = formatUnavailable("git_status", repo);

  if (unavailable) {
    return { ...unavailable, branch: null, head: null, hasHead: false, clean: true, files: [], truncated: false };
  }

  const scopedPath = ensureInsideWorkspace(context.workspaceRoot, args.path);
  const repoRoot = requireRepoRoot(repo);
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    allowNulOutput: true,
    args: [
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      args.include_untracked ? "--untracked-files=all" : "--untracked-files=no",
      "--",
      scopedPath.relativePath,
    ],
  });
  const files = parsePorcelainStatus(result.stdout);

  return {
    tool: "git_status",
    path: scopedPath.relativePath,
    content: formatGitStatusContent(repo, files),
    repoRoot: repo.repoRoot,
    branch: repo.branch,
    head: repo.head,
    hasHead: repo.hasHead,
    clean: files.length === 0,
    files,
    truncated: result.truncated,
    warning: result.truncated ? "git_status output was truncated." : undefined,
  };
}

async function inspectGitDiff(context: ToolContext, args: GitDiffToolArgs): Promise<GitDiffToolResult> {
  const repo = await getRepoInfo(context.workspaceRoot, context.pathEnv);
  const unavailable = formatUnavailable("git_diff", repo);

  if (unavailable) {
    return { ...unavailable, scope: args.scope, path: args.path, fileCount: 0, truncated: false };
  }

  const repoRoot = requireRepoRoot(repo);
  const path = args.path ? ensureInsideWorkspace(context.workspaceRoot, args.path).relativePath : undefined;
  const sections: string[] = [];
  let truncated = false;
  const changedFiles = new Set<string>();

  if (args.scope === "all" || args.scope === "staged") {
    const diff = await runDiff(repoRoot, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames"], {
      context,
      path,
      contextLines: args.context_lines,
      maxBytes: args.max_bytes,
    });
    appendSection(sections, "staged", diff.content);
    truncated = truncated || diff.truncated;
    for (const file of await diffNameOnly(repoRoot, true, context, path)) {
      changedFiles.add(file);
    }
  }

  if (args.scope === "all" || args.scope === "unstaged") {
    const diff = await runDiff(repoRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"], {
      context,
      path,
      contextLines: args.context_lines,
      maxBytes: args.max_bytes,
    });
    appendSection(sections, "unstaged", diff.content);
    truncated = truncated || diff.truncated;
    for (const file of await diffNameOnly(repoRoot, false, context, path)) {
      changedFiles.add(file);
    }
  }

  if (args.include_untracked && args.scope !== "staged") {
    const untracked = await getUntrackedFiles(repoRoot, context, path);

    for (const file of untracked) {
      const diff = await runDiff(repoRoot, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-renames"], {
        context,
        path: undefined,
        extraPathspecs: ["/dev/null", file],
        contextLines: args.context_lines,
        maxBytes: args.max_bytes,
      });
      appendSection(sections, `untracked ${file}`, diff.content);
      truncated = truncated || diff.truncated;
      changedFiles.add(file);
    }
  }

  const combined = sections.join("\n").trimEnd() || "No diff.";
  const bounded = truncateText(combined, args.max_bytes);

  return {
    tool: "git_diff",
    path: path ?? undefined,
    content: bounded.content,
    repoRoot: repo.repoRoot,
    scope: args.scope,
    fileCount: changedFiles.size,
    truncated: truncated || bounded.truncated,
    warning: truncated || bounded.truncated ? "git_diff output was truncated." : undefined,
  };
}

async function inspectGitLog(context: ToolContext, args: GitLogToolArgs): Promise<GitLogToolResult> {
  const repo = await getRepoInfo(context.workspaceRoot, context.pathEnv);
  const unavailable = formatUnavailable("git_log", repo);

  if (unavailable) {
    return { ...unavailable, commits: [], truncated: false };
  }

  if (!repo.hasHead) {
    return {
      tool: "git_log",
      path: args.path,
      content: "This Git repository has no commits yet.",
      repoRoot: repo.repoRoot,
      commits: [],
      truncated: false,
      warning: "Git repository has no commits.",
    };
  }

  const repoRoot = requireRepoRoot(repo);
  const path = args.path ? ensureInsideWorkspace(context.workspaceRoot, args.path).relativePath : undefined;
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["log", "-n", String(args.limit), `--pretty=format:${gitLogPrettyFormat()}`, "--", ...(path ? [path] : [])],
  });
  const commits = parseGitLog(result.stdout);

  return {
    tool: "git_log",
    path,
    content: commits.length === 0 ? "No commits matched." : commits.map(formatCommitSummary).join("\n"),
    repoRoot: repo.repoRoot,
    commits,
    truncated: result.truncated,
    warning: result.truncated ? "git_log output was truncated." : undefined,
  };
}

async function stageGitPaths(context: ToolContext, args: GitAddToolArgs): Promise<GitAddToolResult> {
  const repo = await requireAvailableRepo(context);
  const repoRoot = requireRepoRoot(repo);
  const paths = normalizeExplicitPaths(context.workspaceRoot, args.paths);
  const expected = new Map(args.expected_status.map((entry) => [entry.path, entry.status]));
  const status = await currentStatus(repoRoot, context, true);
  const statusByPath = new Map(status.map((file) => [file.path, file]));

  for (const path of paths) {
    const file = statusByPath.get(path);
    const expectedStatus = expected.get(path);

    if (!expectedStatus) {
      throw new Error(`git_add expected_status is required for ${path}.`);
    }

    if (!file) {
      throw new Error(`git_add can only stage paths present in git_status: ${path}`);
    }

    if (file.status !== expectedStatus) {
      throw new Error(`git_add expected ${path} to be ${expectedStatus}, but it is ${file.status}.`);
    }
  }

  const result = await runGit({ cwd: repoRoot, pathEnv: context.pathEnv, args: ["add", "--", ...paths] });

  if (result.exitCode !== 0) {
    throw new Error(`git_add failed: ${result.stderr || result.stdout}`.trim());
  }

  const files = await currentStatus(repoRoot, context, true);
  const stagedPaths = files.filter((file) => file.staged).map((file) => file.path);

  return {
    tool: "git_add",
    content: [`staged_paths: ${paths.join(", ")}`, "", formatGitStatusFileList(files)].join("\n").trimEnd(),
    repoRoot: repo.repoRoot,
    stagedPaths: paths,
    files,
    warning: paths.every((path) => stagedPaths.includes(path)) ? undefined : "Some requested paths were not staged.",
  };
}

async function commitGitPaths(context: ToolContext, args: GitCommitToolArgs): Promise<GitCommitToolResult> {
  const repo = await requireAvailableRepo(context);
  const repoRoot = requireRepoRoot(repo);
  const expectedPaths = normalizeExplicitPaths(context.workspaceRoot, args.expected_staged_paths);
  const beforeStatus = await currentStatus(repoRoot, context, true);
  const stagedFiles = beforeStatus.filter((file) => file.staged);
  const stagedPaths = stagedFiles.map((file) => file.path).sort();

  if (stagedPaths.length === 0) {
    throw new Error("git_commit requires staged changes.");
  }

  if (!sameStringSet(stagedPaths, [...expectedPaths].sort())) {
    throw new Error(
      `git_commit staged paths did not match expected_staged_paths. staged=${stagedPaths.join(", ")} expected=${expectedPaths.join(", ")}`
    );
  }

  const stagedWithUnstagedChanges = stagedFiles.filter((file) => file.unstaged).map((file) => file.path);

  if (stagedWithUnstagedChanges.length > 0) {
    throw new Error(
      `git_commit refuses paths with both staged and unstaged changes: ${stagedWithUnstagedChanges.join(", ")}`
    );
  }

  const stat = await runGit({ cwd: repoRoot, pathEnv: context.pathEnv, args: ["diff", "--cached", "--stat", "--"] });
  const nameStatus = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["diff", "--cached", "--name-status", "--"],
  });
  const commit = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["commit", "--no-gpg-sign", "-m", args.message],
    timeoutMs: 30_000,
  });

  if (commit.exitCode !== 0) {
    throw new Error(`git_commit failed: ${commit.stderr || commit.stdout}`.trim());
  }

  const latest = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["log", "-n", "1", `--pretty=format:${gitLogPrettyFormat()}`],
  });
  const commitSummary = parseGitLog(latest.stdout)[0];

  if (!commitSummary) {
    throw new Error("git_commit succeeded but the new commit could not be read.");
  }

  const remainingFiles = await currentStatus(repoRoot, context, true);

  return {
    tool: "git_commit",
    content: [
      `commit: ${commitSummary.shortSha} ${commitSummary.subject}`,
      `staged_paths: ${stagedPaths.join(", ")}`,
      "",
      "stat:",
      stat.stdout.trim() || "(none)",
      "",
      "remaining:",
      formatGitStatusFileList(remainingFiles) || "clean",
    ].join("\n"),
    repoRoot: repo.repoRoot,
    commit: commitSummary,
    stagedPaths,
    remainingFiles,
    stat: stat.stdout,
    nameStatus: nameStatus.stdout,
  };
}

async function requireAvailableRepo(context: ToolContext): Promise<GitRepoInfo> {
  const repo = await getRepoInfo(context.workspaceRoot, context.pathEnv);

  if (!repo.available) {
    throw new Error(repo.message ?? "Git repository is unavailable.");
  }

  return repo;
}

async function currentStatus(
  repoRoot: string,
  context: ToolContext,
  includeUntracked: boolean
): Promise<GitChangedFile[]> {
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    allowNulOutput: true,
    args: [
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
      "--",
    ],
  });

  return parsePorcelainStatus(result.stdout);
}

async function runDiff(
  repoRoot: string,
  baseArgs: string[],
  options: {
    context: ToolContext;
    path: string | undefined;
    contextLines: number;
    maxBytes: number;
    extraPathspecs?: string[];
  }
): Promise<{ content: string; truncated: boolean }> {
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: options.context.pathEnv,
    args: [
      ...baseArgs,
      `--unified=${options.contextLines}`,
      "--",
      ...(options.extraPathspecs ?? (options.path ? [options.path] : [])),
    ],
    maxOutputBytes: options.maxBytes,
    allowExitCodeOne: true,
  });

  if (result.binary) {
    return { content: "Binary diff omitted.", truncated: result.truncated };
  }

  return { content: result.stdout, truncated: result.truncated };
}

async function diffNameOnly(
  repoRoot: string,
  staged: boolean,
  context: ToolContext,
  path: string | undefined
): Promise<string[]> {
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["diff", staged ? "--cached" : "--no-ext-diff", "--name-only", "--", ...(path ? [path] : [])],
  });

  return result.stdout.split("\n").filter(Boolean);
}

async function getUntrackedFiles(repoRoot: string, context: ToolContext, path: string | undefined): Promise<string[]> {
  const result = await runGit({
    cwd: repoRoot,
    pathEnv: context.pathEnv,
    args: ["ls-files", "--others", "--exclude-standard", "--", ...(path ? [path] : [])],
  });

  return result.stdout.split("\n").filter(Boolean);
}

function appendSection(sections: string[], label: string, content: string): void {
  if (content.trim().length === 0) {
    return;
  }

  sections.push(`## ${label}\n${content.trimEnd()}\n`);
}

function formatUnavailable<Name extends "git_status" | "git_diff" | "git_log">(
  tool: Name,
  repo: GitRepoInfo
): (ToolResult<Name> & { repoRoot: null }) | undefined {
  if (repo.available) {
    return undefined;
  }

  return {
    tool,
    repoRoot: null,
    content: repo.message ?? "Git repository is unavailable.",
    warning: repo.message,
  } as ToolResult<Name> & { repoRoot: null };
}

function formatGitStatusContent(repo: GitRepoInfo, files: GitChangedFile[]): string {
  return [
    `branch: ${repo.branch ?? "(detached)"}`,
    `head: ${repo.head ?? "(none)"}`,
    `clean: ${files.length === 0}`,
    "",
    formatGitStatusFileList(files) || "No changed files.",
  ].join("\n");
}

function formatGitStatusFileList(files: GitChangedFile[]): string {
  return files
    .map((file) => `${file.indexStatus}${file.worktreeStatus} ${file.path}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

function formatCommitSummary(commit: GitCommitSummary): string {
  return `${commit.shortSha} ${commit.subject} (${commit.authorName}, ${new Date(commit.timestamp * 1000).toISOString()})`;
}

function requireRepoRoot(repo: GitRepoInfo): string {
  if (!repo.repoRootAbsolute) {
    throw new Error("Git repository root is unavailable.");
  }

  return repo.repoRootAbsolute;
}

function normalizeExplicitPaths(workspaceRoot: string, paths: string[]): string[] {
  const normalized = paths.map((path) => {
    if (path === "." || path.includes("*") || path.includes("?") || path.includes("[") || path.includes("]")) {
      throw new Error(`Git mutation tools require explicit file paths, not broad pathspecs: ${path}`);
    }

    const scoped = ensureInsideWorkspace(workspaceRoot, path);

    if (scoped.relativePath === ".") {
      throw new Error("Git mutation tools require explicit file paths.");
    }

    return scoped.relativePath;
  });

  return [...new Set(normalized)];
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
