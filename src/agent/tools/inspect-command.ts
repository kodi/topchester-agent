import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
  type InspectCommandEntry,
  type InspectCommandPlan,
  type InspectCommandPipeline,
  type InspectSimpleCommand,
} from "./inspect-command-parser.js";
import { type InspectCommandArgs, inspectCommandArgsSchema, validateInspectCommand } from "./inspect-command-policy.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

const MAX_OUTPUT_BYTES = 40_000;
const MAX_OUTPUT_LINES = 1_000;

export { inspectCommandArgsSchema, type InspectCommandArgs };

export type InspectCommandToolCall = ToolCall<"inspect_command", InspectCommandArgs>;

export interface InspectCommandToolResult extends ToolResult<"inspect_command"> {
  cwd: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  decision: {
    allowed: true;
    reason: string;
    commands: string[];
  };
  stdout: string;
  stderr: string;
}

export interface InspectCommandOptions {
  pathEnv?: string;
}

export const inspectCommandTool = defineTool({
  name: "inspect_command",
  description: "Run a narrowly validated read-only command for repository orientation.",
  prompt:
    'inspect_command: run a safe read-only discovery command inside the workspace for quick orientation; prefer read_file, list_files, grep, and find_file for exact file tasks, and do not use it for builds, tests, installs, network, shell scripts, or edits. To use it, reply with only JSON: {"tool":"inspect_command","args":{"command":"pwd && rg --files docs/plans | head -20","workdir":".","timeout_ms":10000}}',
  argsSchema: inspectCommandArgsSchema,
  execute: (context, args) => inspectWorkspaceCommand(context.workspaceRoot, args, { pathEnv: context.pathEnv }),
});

interface PipelineExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

interface CommandExecutionResult extends PipelineExecutionResult {
  missingExecutable?: string;
}

export async function inspectWorkspaceCommand(
  workspaceRoot: string,
  args: InspectCommandArgs,
  options: InspectCommandOptions = {}
): Promise<InspectCommandToolResult> {
  const startedAt = Date.now();
  const decision = validateInspectCommand(args, { workspaceRoot });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  const resolvedWorkspace = await realpath(resolve(workspaceRoot));
  const cwd = await resolveWorkspaceCwd(resolvedWorkspace, args.workdir);
  const deadlineAt = startedAt + args.timeout_ms;
  const result = await executePlan(decision.plan, {
    cwd,
    pathEnv: options.pathEnv ?? process.env.PATH ?? "",
    deadlineAt,
  });
  const durationMs = Date.now() - startedAt;

  return {
    tool: "inspect_command",
    command: args.command,
    cwd: relative(resolvedWorkspace, cwd) || ".",
    content: formatInspectCommandContent(result),
    exitCode: result.exitCode,
    durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    warning: result.missingExecutable
      ? `inspect_command could not run because '${result.missingExecutable}' is not available on PATH.`
      : result.timedOut
        ? "inspect_command timed out."
        : result.truncated
          ? "inspect_command output was truncated."
          : undefined,
    decision: {
      allowed: true,
      reason: decision.reason,
      commands: decision.commands,
    },
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function executePlan(
  plan: InspectCommandPlan,
  context: { cwd: string; pathEnv: string; deadlineAt: number }
): Promise<CommandExecutionResult> {
  let lastExitCode = 0;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let truncated = false;

  for (const entry of plan.entries) {
    if (!shouldExecuteEntry(entry, lastExitCode)) {
      continue;
    }

    const remainingMs = getRemainingTimeoutMs(context.deadlineAt);

    if (remainingMs <= 0) {
      return {
        stdout,
        stderr,
        exitCode: lastExitCode,
        timedOut: true,
        truncated,
      };
    }

    const result = await executePipeline(entry.pipeline, { ...context, timeoutMs: remainingMs });
    stdout = appendBoundedOutput(stdout, result.stdout).output;
    const nextStderr = appendBoundedOutput(stderr, result.stderr);
    stderr = nextStderr.output;
    truncated = truncated || result.truncated || nextStderr.truncated;
    timedOut = timedOut || result.timedOut;
    lastExitCode = result.exitCode;

    if (result.missingExecutable || result.timedOut) {
      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
        timedOut,
        truncated,
        missingExecutable: result.missingExecutable,
      };
    }
  }

  return {
    stdout,
    stderr,
    exitCode: lastExitCode,
    timedOut,
    truncated,
  };
}

async function executePipeline(
  pipeline: InspectCommandPipeline,
  context: { cwd: string; pathEnv: string; deadlineAt: number; timeoutMs: number }
): Promise<CommandExecutionResult> {
  let input = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  let truncated = false;

  for (const command of pipeline.commands) {
    const remainingMs = getRemainingTimeoutMs(context.deadlineAt);

    if (remainingMs <= 0) {
      return { stdout: input, stderr, exitCode, timedOut: true, truncated };
    }

    const result = await executeSimpleCommand(command, input, { ...context, timeoutMs: remainingMs });
    input = result.stdout;
    const nextStderr = appendBoundedOutput(stderr, result.stderr);
    stderr = nextStderr.output;
    exitCode = result.exitCode;
    timedOut = timedOut || result.timedOut;
    truncated = truncated || result.truncated || nextStderr.truncated;

    if (result.missingExecutable || result.timedOut || result.exitCode !== 0) {
      return {
        stdout: input,
        stderr,
        exitCode,
        timedOut,
        truncated,
        missingExecutable: result.missingExecutable,
      };
    }
  }

  return { stdout: input, stderr, exitCode, timedOut, truncated };
}

async function executeSimpleCommand(
  command: InspectSimpleCommand,
  input: string,
  context: { cwd: string; pathEnv: string; timeoutMs: number }
): Promise<CommandExecutionResult> {
  if (command.executable === "pwd") {
    return {
      stdout: `${context.cwd}\n`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    };
  }

  const executablePath = await findExecutable(command.executable, context.pathEnv);

  if (!executablePath) {
    return {
      stdout: "",
      stderr: `inspect_command could not run because '${command.executable}' is not available on PATH.\n`,
      exitCode: 127,
      timedOut: false,
      truncated: false,
      missingExecutable: command.executable,
    };
  }

  return runSpawnedCommand(executablePath, command.args, input, context);
}

function runSpawnedCommand(
  command: string,
  args: string[],
  input: string,
  context: { cwd: string; pathEnv: string; timeoutMs: number }
): Promise<CommandExecutionResult> {
  return new Promise((resolveCommand) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: context.cwd,
      detached,
      env: {
        ...process.env,
        PATH: context.pathEnv,
        PAGER: "cat",
        GIT_PAGER: "cat",
        LESS: "-F -X",
      },
      stdio: [input.length > 0 ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild(child.pid, detached, "SIGTERM");
      setTimeout(() => {
        if (!settled) {
          killChild(child.pid, detached, "SIGKILL");
        }
      }, 250).unref();
    }, context.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(stdout, stripUnsafeControlCharacters(chunk.toString("utf8")));
      stdout = next.output;
      truncated = truncated || next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(stderr, stripUnsafeControlCharacters(chunk.toString("utf8")));
      stderr = next.output;
      truncated = truncated || next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      settled = true;
      resolveCommand({
        stdout,
        stderr: stderr || `${error.message}\n`,
        exitCode: 1,
        timedOut,
        truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      settled = true;
      resolveCommand({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? (signal ? 1 : 0)),
        timedOut,
        truncated,
      });
    });

    if (child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          const next = appendBoundedOutput(stderr, `${error.message}\n`);
          stderr = next.output;
          truncated = truncated || next.truncated;
        }
      });
      child.stdin.end(input);
    }
  });
}

function killChild(pid: number | undefined, detached: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(detached ? -pid : pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}

async function resolveWorkspaceCwd(workspaceRoot: string, workdir: string): Promise<string> {
  const resolvedCwd = resolve(workspaceRoot, workdir);
  const info = await stat(resolvedCwd);

  if (!info.isDirectory()) {
    throw new Error(`inspect_command workdir must be a directory inside the workspace: ${workdir}`);
  }

  const realCwd = await realpath(resolvedCwd);
  const relativePath = relative(workspaceRoot, realCwd);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`inspect_command rejected path outside the workspace: ${workdir}`);
  }

  return realCwd;
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

function shouldExecuteEntry(entry: InspectCommandEntry, previousExitCode: number): boolean {
  switch (entry.operator) {
    case "start":
    case ";":
      return true;
    case "&&":
      return previousExitCode === 0;
    case "||":
      return previousExitCode !== 0;
  }
}

function getRemainingTimeoutMs(deadlineAt: number): number {
  return deadlineAt - Date.now();
}

function formatInspectCommandContent(result: PipelineExecutionResult): string {
  const sections = [];

  sections.push(result.stdout.trimEnd() || "(no output)");

  if (result.stderr.trim()) {
    sections.push(["stderr:", result.stderr.trimEnd()].join("\n"));
  }

  sections.push(
    [
      "metadata:",
      `exit_code: ${result.exitCode}`,
      `timed_out: ${result.timedOut}`,
      `truncated: ${result.truncated}`,
    ].join("\n")
  );

  return sections.join("\n\n");
}

function appendBoundedOutput(current: string, next: string): { output: string; truncated: boolean } {
  const combined = current + next;
  const byteLimited = Buffer.byteLength(combined, "utf8") > MAX_OUTPUT_BYTES;
  const lines = combined.split("\n");
  const lineLimited = lines.length > MAX_OUTPUT_LINES;

  if (!byteLimited && !lineLimited) {
    return { output: combined, truncated: false };
  }

  let output = combined;

  if (byteLimited) {
    output = output.slice(0, MAX_OUTPUT_BYTES);
  }

  if (lineLimited) {
    output = output.split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
  }

  return { output: `${output.trimEnd()}\n[truncated]\n`, truncated: true };
}

function stripUnsafeControlCharacters(output: string): string {
  return output.replace(/[^\t\n\r -~]/g, "");
}
