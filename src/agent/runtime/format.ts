import { type ModelAgentResult } from "../../model/index.js";
import {
  isToolErrorResult,
  type ToolCall,
  type ToolCallParseRejection,
  type ToolCallSource,
  type ToolExecutionResult,
  type ToolProtocol,
  type ToolResult,
} from "../tools.js";

export interface TurnTokenUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Serializes a tool execution result into the text that is fed back to the
 * model after a tool call. Each tool gets the metadata the model needs for
 * the next step, such as file hashes, diffs, command exit status, truncation
 * state, or KB dirty-state signals, while errors are presented in a uniform
 * error block.
 */
export function formatToolResultForPrompt(result: ToolExecutionResult<ToolResult>): string {
  const path = result.path ? ` ${JSON.stringify(result.path)}` : "";
  const command = "command" in result && result.command ? ` via ${result.command}` : "";
  const warning = result.warning ? `\nWarning: ${result.warning}` : "";

  if (isToolErrorResult(result)) {
    return [
      `Tool result from ${result.tool}${path}${command}:`,
      `Error: ${result.error}`,
      "```",
      result.content,
      "```",
    ].join("\n");
  }

  if (isProjectInstructionRetryResult(result)) {
    return [`Tool result from ${result.tool}${path}${command}:${warning}`, result.content].join("\n");
  }

  if ((result.tool === "edit_file" && !("diff" in result)) || (result.tool === "write_file" && !("hash" in result))) {
    return [`Tool result from ${result.tool}${path}${command}:${warning}`, result.content].join("\n");
  }

  if (result.tool === "read_file") {
    return [
      `Tool result from ${result.tool}${path}${command}:${warning}`,
      `hash: ${result.hash}`,
      "```",
      result.content,
      "```",
    ].join("\n");
  }

  if (result.tool === "plan_todo") {
    return [`Tool result from ${result.tool}:`, result.content].join("\n");
  }

  if (result.tool === "task") {
    return [`Tool result from ${result.tool}:`, result.content].join("\n");
  }

  if (result.tool === "edit_file" && "diff" in result) {
    return [
      `Tool result from ${result.tool}${path}:`,
      `before_hash: ${result.beforeHash}`,
      `after_hash: ${result.afterHash}`,
      `kb_state: ${result.kbState}`,
      `bytes_changed: ${result.bytesChanged}`,
      `first_changed_line: ${result.firstChangedLine}`,
      "```diff",
      formatDiffForPrompt(result.diff),
      "```",
    ].join("\n");
  }

  if (result.tool === "write_file" && "hash" in result) {
    return [
      `Tool result from ${result.tool}${path}:`,
      result.beforeHash ? `before_hash: ${result.beforeHash}` : "",
      `after_hash: ${result.hash}`,
      `bytes_written: ${result.bytesWritten}`,
      result.bytesChanged !== undefined ? `bytes_changed: ${result.bytesChanged}` : "",
      `line_count: ${result.lineCount}`,
      result.lineDelta !== undefined ? `line_delta: ${result.lineDelta}` : "",
      `kb_state: ${result.kbState}`,
      result.createdParentDirs.length > 0 ? `created_parent_dirs: ${result.createdParentDirs.join(", ")}` : "",
      `summary: ${result.writeEvent.writeSummary}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "inspect_command") {
    return [
      `Tool result from ${result.tool} via ${result.command}:`,
      `cwd: ${result.cwd}`,
      `exit_code: ${result.exitCode}`,
      `timed_out: ${result.timedOut}`,
      `truncated: ${result.truncated}`,
      `decision: ${result.decision.reason}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "run_validator") {
    return [
      `Tool result from ${result.tool} via ${result.command}:`,
      `cwd: ${result.cwd}`,
      `exit_code: ${result.exitCode}`,
      `duration_ms: ${result.durationMs}`,
      `timed_out: ${result.timedOut}`,
      `truncated: ${result.truncated}`,
      `policy: ${result.policy.reason}`,
      `workspace_may_have_changed: ${result.workspaceMayHaveChanged}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "bash") {
    return [
      `Tool result from ${result.tool} via ${result.command}:`,
      `cwd: ${result.cwd}`,
      `exit_code: ${result.exitCode}`,
      `duration_ms: ${result.durationMs}`,
      `timed_out: ${result.timedOut}`,
      `aborted: ${result.aborted}`,
      `truncated: ${result.truncated}`,
      `shell: ${result.shell}`,
      `policy: ${result.policy.reason}`,
      `workspace_may_have_changed: ${result.workspaceMayHaveChanged}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "git_status") {
    return [
      `Tool result from ${result.tool}${path}:`,
      `repo_root: ${result.repoRoot ?? "(none)"}`,
      `branch: ${result.branch ?? "(detached)"}`,
      `head: ${result.head ?? "(none)"}`,
      `has_head: ${result.hasHead}`,
      `clean: ${result.clean}`,
      `changed_file_count: ${result.files.length}`,
      `truncated: ${result.truncated}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "git_diff") {
    return [
      `Tool result from ${result.tool}${path}:`,
      `repo_root: ${result.repoRoot ?? "(none)"}`,
      `scope: ${result.scope}`,
      `path: ${result.path ?? "(all)"}`,
      `file_count: ${result.fileCount}`,
      `truncated: ${result.truncated}`,
      warning ? warning.trimStart() : "",
      "```diff",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "git_log") {
    return [
      `Tool result from ${result.tool}${path}:`,
      `repo_root: ${result.repoRoot ?? "(none)"}`,
      `commit_count: ${result.commits.length}`,
      `truncated: ${result.truncated}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "git_add") {
    return [
      `Tool result from ${result.tool}:`,
      `repo_root: ${result.repoRoot ?? "(none)"}`,
      `staged_paths: ${result.stagedPaths.join(", ")}`,
      warning ? warning.trimStart() : "",
      "```",
      result.content,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.tool === "git_commit") {
    return [
      `Tool result from ${result.tool}:`,
      `repo_root: ${result.repoRoot ?? "(none)"}`,
      `commit: ${result.commit.shortSha} ${result.commit.subject}`,
      `staged_paths: ${result.stagedPaths.join(", ")}`,
      `remaining_changed_file_count: ${result.remainingFiles.length}`,
      "```",
      result.content,
      "```",
    ].join("\n");
  }

  return [`Tool result from ${result.tool}${path}${command}:${warning}`, "```", result.content, "```"].join("\n");
}

/**
 * Builds the follow-up instruction appended after each tool result. It keeps
 * the model on the active task, reminds it to maintain the visible plan, and
 * restates the current tool-call protocol so the next model step remains
 * parseable by the runtime.
 */
export function formatContinuationInstruction(
  protocol: ToolProtocol,
  result: ToolExecutionResult<ToolResult>,
  canUsePlanTodo = true
): string {
  const toolInstruction =
    protocol === "text-xml"
      ? "If another tool is needed, reply with only one XML tool call."
      : protocol === "text-json"
        ? "If another tool is needed, reply with only that tool JSON."
        : "If another tool is needed, use the available tool calling path.";
  const resultInstruction =
    result.tool === "find_file"
      ? "find_file results are paths only; if the user asked to read or answer from file contents, call read_file on the relevant path before answering. Do not ask the user to provide the read_file result or permission."
      : "";

  return [
    "Continue the user's request using the tool result above and the visible plan when one is active.",
    resultInstruction,
    canUsePlanTodo ? "Update plan_todo after major progress changes." : "",
    canUsePlanTodo
      ? "Before a final answer, close the visible plan by calling plan_todo with all finished items marked completed, or with [] if abandoning the plan."
      : "",
    toolInstruction,
    "Otherwise answer the user. Do not guess.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Creates the corrective prompt used when the model tries to answer while a
 * visible task plan is still open. The draft final answer is preserved so the
 * model can reuse it after closing the plan, but the immediate instruction is
 * to call `plan_todo` first.
 */
export function formatOpenPlanClosureInstruction(draftAnswer: string, protocol: ToolProtocol): string {
  const toolInstruction =
    protocol === "text-xml"
      ? "Reply now with only one XML plan_todo tool call."
      : protocol === "text-json"
        ? "Reply now with only the plan_todo JSON object."
        : "Use the available tool calling path now to call plan_todo.";
  const trimmedDraft = draftAnswer.trim();

  return [
    "The visible plan still has unfinished items, so do not provide the final answer yet.",
    "First close the plan with plan_todo: mark completed work as completed, keep one item in_progress only if work truly remains, or use [] if abandoning the plan.",
    toolInstruction,
    trimmedDraft
      ? `After the plan_todo result, use this draft final answer if it is still accurate:\n${trimmedDraft}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatInvalidToolCallRepairInstruction(rejection: ToolCallParseRejection): string {
  return [
    `Your previous response looked like a ${rejection.tool} tool call, but its arguments did not match the tool schema.`,
    `Validation error: ${rejection.reason}`,
    "Do not answer with that JSON as chat text.",
    rejection.tool === "run_validator"
      ? "If this command is not a strict validator shape but the user still needs command output, retry with bash when approval or project policy allows it."
      : "",
    "Reply now with one valid tool call JSON object for the next action, or answer in plain text if no tool is needed.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function getTextToolCallSources(protocol: ToolProtocol): readonly ToolCallSource[] {
  return protocol === "text-xml" ? ["text-xml"] : protocol === "text-json" ? ["text-json"] : ["text-json", "text-xml"];
}

/**
 * Formats a compact, user-visible summary for a tool call event. When a
 * result is available the summary includes useful completion details, such as
 * changed-line counts, staged paths, commit subjects, or command failures,
 * instead of echoing the full tool payload.
 */
export function formatToolCallMessage(call: ToolCall, result?: ToolExecutionResult<ToolResult>): string {
  if (result && isToolErrorResult(result)) {
    return `${call.tool} failed: ${result.error}`;
  }

  switch (call.tool) {
    case "task":
      return result?.tool === "task"
        ? `task: ${result.status} ${result.childSessionId}`
        : `task: ${call.args.description}`;
    case "plan_todo":
      return result?.tool === "plan_todo"
        ? `plan_todo: ${result.plan.items.length} items, ${result.inProgressCount} active`
        : `plan_todo: ${call.args.items.length} items`;
    case "read_file":
      return `read_file: ${call.args.path}`;
    case "list_files":
      return `list_files: ${call.args.path}${call.args.recursive ? " (recursive)" : ""}`;
    case "grep":
      return `grep: ${call.args.pattern} in ${call.args.path ?? "."}`;
    case "find_file":
      return `find_file: ${call.args.query} in ${call.args.path}`;
    case "edit_file":
      return `edit_file: ${call.args.path}${formatEditFileChangeSummary(result)}`;
    case "write_file":
      return `write_file: ${call.args.path}${formatWriteFileChangeSummary(result)}`;
    case "git_status":
      return `git_status: ${result?.tool === "git_status" ? `${result.files.length} changed` : call.args.path}`;
    case "git_diff":
      return `git_diff: ${formatGitDiffCallSummary(call, result)}`;
    case "git_log":
      return `git_log: ${result?.tool === "git_log" ? `${result.commits.length} commits` : `${call.args.limit} commits`}`;
    case "git_add":
      return `git_add: ${result?.tool === "git_add" ? `${result.stagedPaths.length} files staged` : `${call.args.paths.length} files`}`;
    case "git_commit":
      return `git_commit: ${result?.tool === "git_commit" ? `${result.commit.shortSha} ${result.commit.subject}` : call.args.message}`;
    case "inspect_command":
      return `inspect_command: ${call.args.command}`;
    case "run_validator":
      return result?.tool === "run_validator" && !isToolErrorResult(result)
        ? `run_validator: ${call.args.command} (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}, ${formatSeconds(result.durationMs)})`
        : `run_validator: ${call.args.command}`;
    case "bash":
      return result?.tool === "bash" && !isToolErrorResult(result)
        ? `bash: ${call.args.command} (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}, ${formatSeconds(result.durationMs)})`
        : `bash: ${call.args.command}`;
    case "skills_list":
      return result?.tool === "skills_list" && !isToolErrorResult(result)
        ? `skills_list: ${result.skills.active.length} skills`
        : "skills_list";
    case "skill_view":
      return `skill_view: ${call.args.name}`;
  }
}

/**
 * Formats the assistant-message metadata shown next to the final response.
 * The model identifier and cumulative turn duration are kept together here
 * so callers do not need to know how agent-loop timing should be presented.
 */
export function formatAgentMessageMeta(model: string, durationMs: number, usage?: TurnTokenUsageTotals): string {
  const tokenUsage = shouldShowTokenUsageByEnv() ? formatTokenUsage(usage) : undefined;

  return [model, formatDuration(durationMs), tokenUsage].filter(Boolean).join(" · ");
}

export function addTokenUsageTotals(totals: TurnTokenUsageTotals, usage: ModelAgentResult["usage"]): void {
  if (!usage) {
    return;
  }

  if (typeof usage.inputTokens === "number") {
    totals.inputTokens = (totals.inputTokens ?? 0) + usage.inputTokens;
  }

  if (typeof usage.outputTokens === "number") {
    totals.outputTokens = (totals.outputTokens ?? 0) + usage.outputTokens;
  }

  if (typeof usage.costUsd === "number") {
    totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
  }
}

function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Summarizes a `git_diff` call for the TUI event list. Successful results
 * report the resolved scope, file count, and truncation marker; pending or
 * failed calls fall back to the requested scope from the tool arguments.
 */
function formatGitDiffCallSummary(
  call: Extract<ToolCall, { tool: "git_diff" }>,
  result?: ToolExecutionResult<ToolResult>
): string {
  if (result?.tool === "git_diff" && !isToolErrorResult(result)) {
    return `${result.scope} (${result.fileCount} files${result.truncated ? ", truncated" : ""})`;
  }

  return call.args.scope;
}

/**
 * Returns the parenthesized change summary for a successful `edit_file`
 * result. Non-edit results and failed edits intentionally return an empty
 * suffix so the main tool-call formatter can keep one path for success,
 * failure, and pre-result display.
 */
function formatEditFileChangeSummary(result: ToolExecutionResult<ToolResult> | undefined): string {
  if (result?.tool !== "edit_file" || isToolErrorResult(result) || !("editEvent" in result)) {
    return "";
  }

  return ` (changed ${result.editEvent.diffSummary})`;
}

/**
 * Returns the parenthesized write summary for a successful `write_file`
 * result. The helper mirrors the edit summary helper, keeping write-specific
 * result details out of the larger switch that formats all tool-call messages.
 */
function formatWriteFileChangeSummary(result: ToolExecutionResult<ToolResult> | undefined): string {
  if (result?.tool !== "write_file" || isToolErrorResult(result) || !("writeEvent" in result)) {
    return "";
  }

  return ` (${result.writeEvent.writeSummary})`;
}

function formatDiffForPrompt(diff: string): string {
  return diff
    .split("\n")
    .map((line) => line.replace(/^([ +-])\s*\d+\s+│\s?/u, "$1"))
    .join("\n");
}

function isProjectInstructionRetryResult(
  result: ToolExecutionResult<ToolResult>
): result is ToolExecutionResult<ToolResult> & {
  tool: "edit_file" | "write_file";
  projectInstructions: NonNullable<ToolResult["projectInstructions"]>;
} {
  return Boolean(
    !isToolErrorResult(result) &&
    result.projectInstructions &&
    (result.tool === "edit_file" || result.tool === "write_file")
  );
}

function shouldShowTokenUsageByEnv(): boolean {
  const value = process.env.TOPCHESTER_SHOW_TOKEN_USAGE?.trim().toLowerCase();

  return value !== undefined && value !== "" && value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

function formatTokenUsage(usage: TurnTokenUsageTotals | undefined): string | undefined {
  if (usage?.inputTokens === undefined && usage?.outputTokens === undefined && usage?.costUsd === undefined) {
    return undefined;
  }

  const tokenUsage =
    usage.inputTokens === undefined && usage.outputTokens === undefined
      ? undefined
      : `${formatInteger(usage.inputTokens ?? 0)} input / ${formatInteger(usage.outputTokens ?? 0)} output tokens`;
  const cost = usage.costUsd === undefined ? undefined : formatUsdCost(usage.costUsd);

  return [tokenUsage, cost].filter(Boolean).join(" / ");
}

/**
 * Converts elapsed milliseconds into the short human-readable duration used
 * in assistant metadata. Very short turns keep one decimal place, normal
 * sub-minute turns round to seconds, and longer turns switch to minutes plus
 * remaining seconds.
 */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, durationMs / 1000);

  if (totalSeconds < 10) {
    return `${formatNumber(totalSeconds, 1)} sec`;
  }

  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)} sec`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (seconds === 0) {
    return `${minutes} min`;
  }

  return `${minutes} min ${seconds} sec`;
}

/**
 * Formats a number with a fixed number of fraction digits using the English
 * locale expected by the TUI metadata strings. Keeping this tiny wrapper
 * avoids repeating the minimum and maximum fraction-digit options at every
 * call site.
 */
function formatNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatInteger(value: number): string {
  return value.toLocaleString("en", {
    maximumFractionDigits: 0,
  });
}

function formatUsdCost(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const fractionDigits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  const formatted = value
    .toFixed(fractionDigits)
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
    .replace(/\.0+$/u, ".00");

  return `$${formatted}`;
}
