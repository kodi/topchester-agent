import { execFile as execFileNode } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export type ToolCall = ReadFileToolCall | GrepToolCall;

export interface ReadFileToolCall {
  tool: "read_file";
  args: {
    path: string;
  };
}

export interface GrepToolCall {
  tool: "grep";
  args: {
    pattern: string;
    path?: string;
  };
}

export interface ToolResult {
  tool: ToolCall["tool"];
  path?: string;
  content: string;
  command?: string;
  warning?: string;
}

export interface GrepWorkspaceOptions {
  pathEnv?: string;
}

export function parseToolCall(text: string): ToolCall | undefined {
  const trimmed = stripJsonFence(text.trim());
  let value: unknown;

  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || !isRecord(value.args)) {
    return undefined;
  }

  if (value.tool === "read_file" && typeof value.args.path === "string") {
    return {
      tool: "read_file",
      args: {
        path: value.args.path,
      },
    };
  }

  if (value.tool === "grep" && typeof value.args.pattern === "string") {
    return {
      tool: "grep",
      args: {
        pattern: value.args.pattern,
        path: typeof value.args.path === "string" ? value.args.path : undefined,
      },
    };
  }

  return undefined;
}

export async function executeToolCall(workspaceRoot: string, call: ToolCall): Promise<ToolResult> {
  switch (call.tool) {
    case "read_file":
      return readWorkspaceFile(workspaceRoot, call.args.path);
    case "grep":
      return grepWorkspace(workspaceRoot, call.args);
  }
}

export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<ToolResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`read_file can only read files inside the workspace: ${path}`);
  }

  const content = await readFile(resolvedPath, "utf8");

  return {
    tool: "read_file",
    path: relativePath || ".",
    content,
  };
}

export async function grepWorkspace(
  workspaceRoot: string,
  args: GrepToolCall["args"],
  options: GrepWorkspaceOptions = {}
): Promise<ToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path ?? ".");
  const executable = await findSearchExecutable(options.pathEnv);

  if (!executable) {
    const warning = "grep could not run because neither rg nor grep is available on PATH.";

    return {
      tool: "grep",
      path: scopedPath.relativePath,
      content: warning,
      warning,
    };
  }

  const commandArgs =
    executable.name === "rg"
      ? [
          "--line-number",
          "--color",
          "never",
          "--hidden",
          "--glob",
          "!.git/**",
          "--no-heading",
          "--",
          args.pattern,
          scopedPath.relativePath,
        ]
      : ["-R", "-n", "--", args.pattern, scopedPath.relativePath];
  const result = await runCommand(executable.path, commandArgs, scopedPath.workspaceRoot);

  if (result.exitCode > 1) {
    throw new Error(
      `${executable.name} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`
    );
  }

  return {
    tool: "grep",
    path: scopedPath.relativePath,
    command: executable.name,
    content: truncateToolOutput(result.stdout.trimEnd() || "No matches."),
  };
}

function resolveWorkspaceScopedPath(workspaceRoot: string, path: string) {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`grep can only search inside the workspace: ${path}`);
  }

  return {
    workspaceRoot: resolvedWorkspace,
    path: resolvedPath,
    relativePath: relativePath || ".",
  };
}

async function findSearchExecutable(pathEnv = process.env.PATH ?? "") {
  for (const name of ["rg", "grep"]) {
    const executablePath = await findExecutable(name, pathEnv);

    if (executablePath) {
      return { name, path: executablePath };
    }
  }

  return undefined;
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
      const code = getExitCode(error);

      resolveCommand({
        exitCode: error ? code : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function getExitCode(error: unknown): number {
  if (isRecord(error) && typeof error.code === "number") {
    return error.code;
  }

  return 1;
}

function truncateToolOutput(output: string): string {
  const maxLength = 40_000;

  if (output.length <= maxLength) {
    return output;
  }

  return `${output.slice(0, maxLength)}\n\n[truncated]`;
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
