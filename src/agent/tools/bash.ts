import { basename } from "node:path";
import { z } from "zod";
import { validateBashPolicy } from "./bash-policy.js";
import { runProcess } from "./process-runner.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const bashArgsSchema = z.object({
  command: z.string().min(1).max(20_000),
  workdir: z.string().optional().default("."),
  timeout_ms: z.number().int().min(100).max(600_000).optional().default(120_000),
  description: z.string().max(500).optional(),
});

export type BashArgs = z.infer<typeof bashArgsSchema>;
export type BashToolCall = ToolCall<"bash", BashArgs>;

export interface BashToolResult extends ToolResult<"bash"> {
  cwd: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  shell: string;
  policy: {
    allowed: true;
    reason: string;
    kind: "allow_exact" | "allow_prefix" | "approved_exact";
    commands: string[];
    matchedRule: string;
  };
  workspaceMayHaveChanged: boolean;
}

export const bashTool = defineTool({
  name: "bash",
  description: "Run an approval-gated shell command inside the workspace.",
  prompt:
    'bash: run an approval-gated shell command inside the workspace for tests, lint, typecheck, builds, smoke checks, package-manager commands, scripts, pipelines, redirects, chaining, and other terminal work. Failed command exits are useful evidence: inspect stdout and stderr, fix in-scope failures, and rerun the narrowest useful check. To use it, reply with only JSON: {"tool":"bash","args":{"command":"pnpm test","workdir":".","timeout_ms":120000,"description":"run the test suite"}}',
  argsSchema: bashArgsSchema,
  requiresExclusiveWorkspace: true,
  execute: async (context, args) =>
    runBashCommand(context.workspaceRoot, args, {
      pathEnv: context.pathEnv,
      abortSignal: context.abortSignal,
      permissions: context.config?.tools?.bash,
      approvedCommands: context.bashApprovals?.allowExactCommands,
    }),
});

export async function runBashCommand(
  workspaceRoot: string,
  args: BashArgs,
  options: {
    pathEnv?: string;
    abortSignal?: AbortSignal;
    permissions?: Parameters<typeof validateBashPolicy>[1]["permissions"];
    approvedCommands?: readonly string[];
  } = {}
): Promise<BashToolResult> {
  const decision = await validateBashPolicy(args, {
    workspaceRoot,
    permissions: options.permissions,
    approvedCommands: options.approvedCommands,
  });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  const result = await runProcess({
    executable: decision.shell,
    args: getShellArgs(decision.shell, decision.command),
    cwd: decision.cwd,
    pathEnv: options.pathEnv,
    timeoutMs: args.timeout_ms,
    abortSignal: options.abortSignal,
    env: {
      NO_COLOR: "1",
    },
    missingExecutableLabel: "bash",
  });

  if (result.missingExecutable) {
    throw new Error(`bash could not run because '${result.missingExecutable}' is not available.`);
  }

  return {
    tool: "bash",
    command: decision.command,
    cwd: decision.workspaceRelativeCwd,
    content: formatBashToolContent({
      command: decision.command,
      cwd: decision.workspaceRelativeCwd,
      shell: decision.shell,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: result.aborted,
      truncated: result.truncated,
      stdout: result.stdout,
      stderr: result.stderr,
      policyReason: decision.policy.reason,
    }),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
    shell: decision.shell,
    warning: result.timedOut ? "bash timed out." : result.truncated ? "bash output was truncated." : undefined,
    policy: decision.policy,
    workspaceMayHaveChanged: true,
  };
}

function getShellArgs(shell: string, command: string): string[] {
  const shellName = basename(shell).toLowerCase();

  if (process.platform === "win32" && (shellName === "cmd" || shellName === "cmd.exe")) {
    return ["/d", "/s", "/c", command];
  }

  if (
    shellName === "powershell" ||
    shellName === "powershell.exe" ||
    shellName === "pwsh" ||
    shellName === "pwsh.exe"
  ) {
    return ["-NoProfile", "-Command", command];
  }

  return ["-lc", command];
}

function formatBashToolContent(result: {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
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
    `shell: ${result.shell}`,
    `exit_code: ${result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
    `timed_out: ${result.timedOut}`,
    `aborted: ${result.aborted}`,
    `truncated: ${result.truncated}`,
    `policy: ${result.policyReason}`,
    "workspace_may_have_changed: true",
  ].join("\n");
}
