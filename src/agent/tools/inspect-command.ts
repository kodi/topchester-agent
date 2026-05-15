import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type InspectCommandEntry,
  type InspectCommandPlan,
  type InspectCommandPipeline,
  type InspectSimpleCommand,
} from "./inspect-command-parser.js";
import { type InspectCommandArgs, inspectCommandArgsSchema, validateInspectCommand } from "./inspect-command-policy.js";
import { appendBoundedOutput, formatWorkspaceRelativePath, resolveWorkspaceCwd, runProcess } from "./process-runner.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

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
  const cwd = await resolveWorkspaceCwd(resolvedWorkspace, args.workdir, "inspect_command");
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
    cwd: formatWorkspaceRelativePath(resolvedWorkspace, cwd),
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

  const result = await runProcess({
    executable: command.executable,
    args: command.args,
    input,
    cwd: context.cwd,
    pathEnv: context.pathEnv,
    timeoutMs: context.timeoutMs,
    missingExecutableLabel: "inspect_command",
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    missingExecutable: result.missingExecutable,
  };
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
