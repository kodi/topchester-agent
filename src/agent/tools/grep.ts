import { execFile as execFileNode } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { type Logger } from "pino";
import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";
import {
  appendProjectInstructionsToToolContent,
  isWorkspacePathDirectory,
  resolveToolProjectInstructions,
} from "./project-instructions.js";

export const grepArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

export type GrepToolArgs = z.infer<typeof grepArgsSchema>;
export type GrepToolCall = ToolCall<"grep", GrepToolArgs>;
export type GrepToolResult = ToolResult<"grep">;

export interface GrepWorkspaceOptions {
  pathEnv?: string;
  logger?: Logger;
}

export const grepTool = defineTool({
  name: "grep",
  description: "Search text inside the workspace.",
  prompt:
    'grep: search text inside file contents in the workspace; output lines are the files containing the matched text, and paths mentioned inside those lines are not confirmed files unless checked with find_file or read_file. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
  argsSchema: grepArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`grep:${args.path ?? "."}`],
  execute: async (context, args) => {
    const result = await grepWorkspace(context.workspaceRoot, args, {
      pathEnv: context.pathEnv,
      logger: context.logger,
    });
    const targetPath = args.path ?? ".";
    const projectInstructions = await resolveToolProjectInstructions(context, {
      targetPath,
      targetIsDirectory: await isWorkspacePathDirectory(context.workspaceRoot, targetPath),
    });

    return {
      ...result,
      content: appendProjectInstructionsToToolContent(result.content, projectInstructions),
      projectInstructions,
    };
  },
});

export async function grepWorkspace(
  workspaceRoot: string,
  args: GrepToolArgs,
  options: GrepWorkspaceOptions = {}
): Promise<GrepToolResult> {
  const scopedPath = resolveWorkspaceScopedPath(workspaceRoot, args.path ?? ".");
  const executable = await findSearchExecutable(options.pathEnv);

  if (!executable) {
    const warning = "grep could not run because neither rg nor grep is available on PATH.";
    options.logger?.debug(
      {
        event: "native_tool_unavailable",
        tool: "grep",
        candidates: ["rg", "grep"],
        path: scopedPath.relativePath,
      },
      "native tool unavailable"
    );

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
          "--no-ignore",
          "--glob",
          "!.git/**",
          "--no-heading",
          "--",
          args.pattern,
          scopedPath.relativePath,
        ]
      : ["-R", "-n", "--", args.pattern, scopedPath.relativePath];
  options.logger?.debug(
    {
      event: "native_tool_selected",
      tool: "grep",
      nativeTool: executable.name,
      path: scopedPath.relativePath,
    },
    "native tool selected"
  );
  const result = await runCommand(executable.path, commandArgs, scopedPath.workspaceRoot);

  options.logger?.debug(
    {
      event: "grep_command_result",
      command: executable.name,
      exitCode: result.exitCode,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    },
    "grep command result"
  );
  options.logger?.trace(
    {
      event: "grep_command_output",
      command: executable.name,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    "grep command output"
  );

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
