import { z } from "zod";
import { type BenchmarkProfile } from "../benchmark-profile.js";
import { validateValidatorCommand, type ValidatorKind } from "./command-policy.js";
import { runProcess, TERMINAL_BENCH_MAX_OUTPUT_BYTES, TERMINAL_BENCH_MAX_OUTPUT_LINES } from "./process-runner.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const validatorKindSchema = z.preprocess(
  (value) => (value === "format" || value === "format-check" || value === "format:check" ? "format_check" : value),
  z.enum(["test", "lint", "typecheck", "format_check", "build", "check", "smoke"])
);

export const runValidatorArgsSchema = z.object({
  command: z.string().min(1).max(2_000),
  validator: validatorKindSchema.optional(),
  workdir: z.string().optional().default("."),
  timeout_ms: z.number().int().min(100).max(600_000).optional().default(120_000),
});

export type RunValidatorArgs = z.infer<typeof runValidatorArgsSchema>;
export type RunValidatorToolCall = ToolCall<"run_validator", RunValidatorArgs>;

export interface RunValidatorToolResult extends ToolResult<"run_validator"> {
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
    kind: "validator";
    validator: ValidatorKind;
    commands: string[];
    packageManager?: "pnpm" | "npm" | "yarn" | "bun";
    packageJsonPath?: string;
  };
  workspaceMayHaveChanged: boolean;
}

export const runValidatorTool = defineTool({
  name: "run_validator",
  description: "Run a strictly validated test, lint, typecheck, build, check, or smoke command inside the workspace.",
  prompt:
    'run_validator: run a strict verification command after edits, such as tests, lint, typecheck, build, check, format-check, or smoke; format means check-only commands such as pnpm format-check, not mutating formatter commands such as pnpm format; failed exits are useful evidence and should be inspected before retrying. To use it, reply with only JSON: {"tool":"run_validator","args":{"command":"pnpm test test/tools.test.ts","validator":"test","workdir":".","timeout_ms":120000}}',
  argsSchema: runValidatorArgsSchema,
  requiresExclusiveWorkspace: true,
  execute: async (context, args) =>
    runValidatorCommand(context.workspaceRoot, args, {
      pathEnv: context.pathEnv,
      abortSignal: context.abortSignal,
      benchmarkProfile: context.benchmarkProfile,
    }),
});

export async function runValidatorCommand(
  workspaceRoot: string,
  args: RunValidatorArgs,
  pathEnvOrOptions?:
    | string
    | {
        pathEnv?: string;
        abortSignal?: AbortSignal;
        benchmarkProfile?: BenchmarkProfile;
      },
  legacyAbortSignal?: AbortSignal
): Promise<RunValidatorToolResult> {
  const options =
    typeof pathEnvOrOptions === "string"
      ? { pathEnv: pathEnvOrOptions, abortSignal: legacyAbortSignal, benchmarkProfile: undefined }
      : (pathEnvOrOptions ?? {});
  const decision = await validateValidatorCommand(args, { workspaceRoot });

  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  const result = await runProcess({
    executable: decision.plan.executable,
    args: decision.plan.args,
    cwd: decision.plan.cwd,
    pathEnv: options.pathEnv,
    timeoutMs: args.timeout_ms,
    abortSignal: options.abortSignal,
    outputLimitBytes: options.benchmarkProfile === "terminal-bench" ? TERMINAL_BENCH_MAX_OUTPUT_BYTES : undefined,
    outputLimitLines: options.benchmarkProfile === "terminal-bench" ? TERMINAL_BENCH_MAX_OUTPUT_LINES : undefined,
    env: {
      CI: "1",
      NO_COLOR: "1",
    },
    missingExecutableLabel: "run_validator",
  });

  if (result.missingExecutable) {
    throw new Error(`run_validator could not run because '${result.missingExecutable}' is not available on PATH.`);
  }

  const toolResult: RunValidatorToolResult = {
    tool: "run_validator",
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
      ? "run_validator timed out."
      : result.truncated
        ? "run_validator output was truncated."
        : undefined,
    policy: decision.policy,
    workspaceMayHaveChanged: doesValidatorMayChangeWorkspace(decision.policy.validator),
  };

  return toolResult;
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

function doesValidatorMayChangeWorkspace(validator: ValidatorKind): boolean {
  return validator === "build" || validator === "check" || validator === "smoke";
}
