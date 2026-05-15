import { z } from "zod";
import { validateRunCommandPolicy } from "./command-policy.js";
import { runProcess } from "./process-runner.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const runCommandArgsSchema = z.object({
  command: z.string().min(1).max(2_000),
  workdir: z.string().optional().default("."),
  timeout_ms: z.number().int().min(100).max(300_000).optional().default(30_000),
});

export type RunCommandArgs = z.infer<typeof runCommandArgsSchema>;
export type RunCommandToolCall = ToolCall<"run_command", RunCommandArgs>;

export interface RunCommandToolResult extends ToolResult<"run_command"> {
  cwd: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  policy: {
    allowed: true;
    reason: string;
    kind: "validator" | "configured_command";
    commands: string[];
    validator?: "test" | "lint" | "typecheck" | "format_check" | "build" | "check" | "smoke";
    packageManager?: "pnpm" | "npm" | "yarn" | "bun";
    packageJsonPath?: string;
    matchedRule?: string;
  };
  workspaceMayHaveChanged: true;
}

export const runCommandTool = defineTool({
  name: "run_command",
  description: "Run a strictly policy-approved project command inside the workspace.",
  prompt:
    'run_command: run a project command only when strict policy allows it; prefer run_validator for tests, lint, typecheck, build, check, format-check, and smoke. To use it, reply with only JSON: {"tool":"run_command","args":{"command":"node scripts/check-fixtures.mjs","workdir":".","timeout_ms":30000}}',
  argsSchema: runCommandArgsSchema,
  requiresExclusiveWorkspace: true,
  execute: async (context, args) =>
    runWorkspaceCommand(
      context.workspaceRoot,
      args,
      context.config?.tools?.commands,
      context.pathEnv,
      context.abortSignal
    ),
});

export async function runWorkspaceCommand(
  workspaceRoot: string,
  args: RunCommandArgs,
  commands: { allow?: readonly string[]; deny?: readonly string[] } | undefined,
  pathEnv?: string,
  abortSignal?: AbortSignal
): Promise<RunCommandToolResult> {
  const decision = await validateRunCommandPolicy(args, { workspaceRoot, commands });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  const result = await runProcess({
    executable: decision.plan.executable,
    args: decision.plan.args,
    cwd: decision.plan.cwd,
    pathEnv,
    timeoutMs: args.timeout_ms,
    abortSignal,
    missingExecutableLabel: "run_command",
  });

  if (result.missingExecutable) {
    throw new Error(`run_command could not run because '${result.missingExecutable}' is not available on PATH.`);
  }

  return {
    tool: "run_command",
    command: decision.plan.displayCommand,
    cwd: decision.plan.workspaceRelativeCwd,
    content: formatCommandToolContent({
      command: decision.plan.displayCommand,
      cwd: decision.plan.workspaceRelativeCwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: result.stdout,
      stderr: result.stderr,
      policyReason: decision.policy.reason,
    }),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
    warning: result.timedOut
      ? "run_command timed out."
      : result.truncated
        ? "run_command output was truncated."
        : undefined,
    policy: decision.policy,
    workspaceMayHaveChanged: true,
  };
}

function formatCommandToolContent(result: {
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  policyReason: string;
}): string {
  return [
    "stdout:",
    result.stdout.trimEnd() || "(no output)",
    "",
    "stderr:",
    result.stderr.trimEnd() || "(no output)",
    "",
    "metadata:",
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit_code: ${result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
    `policy: ${result.policyReason}`,
  ].join("\n");
}
