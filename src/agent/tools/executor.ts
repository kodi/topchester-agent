import { isToolAllowed, type AgentProfile, type ToolPermissionView } from "../profiles.js";
import { type AgentRuntimeEvent } from "../events.js";
import { type SubagentManager } from "../subagents.js";
import { getToolDefinition, isToolName, type ToolCall, type ToolResult } from "./registry.js";
import { type ToolDefinition, type ToolContext, type ToolExecutionResult } from "./types.js";
import { type Logger } from "pino";
import { type TaskPlanController } from "../task-plan.js";
import { type TopchesterConfig } from "../../config/index.js";

export interface ExecuteToolCallOptions {
  pathEnv?: string;
  logger?: Logger;
  config?: TopchesterConfig;
  taskPlan?: TaskPlanController;
  profile?: AgentProfile;
  permissions?: ToolPermissionView;
  subagents?: SubagentManager;
  eventSink?: (event: AgentRuntimeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

type RuntimeToolDefinition = ToolDefinition<string, unknown, ToolResult>;

export async function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions = {}
): Promise<ToolExecutionResult<ToolResult>> {
  const startedAt = Date.now();
  const context: ToolContext = {
    workspaceRoot,
    pathEnv: options.pathEnv,
    logger: options.logger,
    config: options.config,
    taskPlan: options.taskPlan,
    profile: options.profile,
    permissions: options.permissions,
    subagents: options.subagents,
    eventSink: options.eventSink,
    abortSignal: options.abortSignal,
    toolCallId: options.toolCallId,
  };

  try {
    if (!isToolName(call.tool)) {
      throw new Error(`Unknown tool "${call.tool}".`);
    }

    if (options.permissions && !isToolAllowed(options.permissions, call.tool)) {
      throw new Error(`Tool "${call.tool}" is not allowed for agent profile "${options.permissions.profileId}".`);
    }

    const definition = getToolDefinition(call.tool) as RuntimeToolDefinition;
    const parsedCall = { ...call, args: definition.argsSchema.parse(call.args) } as ToolCall;

    options.logger?.debug(
      { event: "tool_call", tool: parsedCall.tool, args: summarizeToolArgs(parsedCall) },
      "tool call"
    );

    const result = await definition.execute(context, parsedCall.args);
    const durationMs = Date.now() - startedAt;

    options.logger?.debug(
      {
        event: "tool_result",
        tool: result.tool,
        path: result.path,
        command: result.command,
        warning: result.warning,
        durationMs,
        contentLength: result.content.length,
        ...summarizeToolResult(result),
      },
      "tool result"
    );
    options.logger?.trace(
      {
        event: "tool_result_content",
        tool: result.tool,
        path: result.path,
        content: result.content,
      },
      "tool result content"
    );

    return result;
  } catch (error) {
    const message = formatErrorMessage(error);

    const logPayload = {
      event: "tool_result",
      tool: call.tool,
      durationMs: Date.now() - startedAt,
      error: message,
      err: error,
    };

    if (typeof options.logger?.warn === "function") {
      options.logger.warn(logPayload, "tool returned error");
    } else {
      options.logger?.debug(logPayload, "tool returned error");
    }

    return {
      tool: call.tool,
      content: `Tool ${call.tool} failed: ${message}`,
      error: message,
      warning: message,
    };
  }
}

function summarizeToolArgs(call: ToolCall): unknown {
  if (call.tool === "plan_todo") {
    const activeItem = call.args.items.find((item) => item.status === "in_progress")?.text;

    return {
      itemCount: call.args.items.length,
      activeItem,
      completedCount: call.args.items.filter((item) => item.status === "completed").length,
    };
  }

  if (call.tool === "write_file") {
    return {
      path: call.args.path,
      contentLength: call.args.content.length,
      lineCount: countLogicalLines(call.args.content),
      createParentDirs: Boolean(call.args.create_parent_dirs),
      overwrite: Boolean(call.args.overwrite),
      expectedCurrentHashProvided: Boolean(call.args.expected_current_hash),
    };
  }

  if (call.tool !== "edit_file") {
    if (call.tool === "run_command") {
      return {
        command: call.args.command,
        workdir: call.args.workdir,
        timeoutMs: call.args.timeout_ms,
      };
    }

    if (call.tool === "run_validator") {
      return {
        command: call.args.command,
        validator: call.args.validator,
        workdir: call.args.workdir,
        timeoutMs: call.args.timeout_ms,
      };
    }

    return call.args;
  }

  return {
    path: call.args.path,
    editCount: call.args.edits.length,
    oldTextLengths: call.args.edits.map((edit) => edit.old_text.length),
    newTextLengths: call.args.edits.map((edit) => edit.new_text.length),
    expectedCurrentHashProvided: Boolean(call.args.expected_current_hash),
  };
}

function summarizeToolResult(result: ToolResult): Record<string, unknown> {
  if (result.tool === "plan_todo") {
    return {
      itemCount: result.plan.items.length,
      activeItem: result.currentItem,
      completedCount: result.completedCount,
    };
  }

  if (result.tool === "inspect_command") {
    return {
      cwd: result.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      decision: result.decision,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    };
  }

  if (result.tool === "run_validator") {
    return {
      cwd: result.cwd,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      policy: result.policy,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      workspaceMayHaveChanged: result.workspaceMayHaveChanged,
    };
  }

  if (result.tool === "run_command") {
    return {
      cwd: result.cwd,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      policy: result.policy,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      workspaceMayHaveChanged: result.workspaceMayHaveChanged,
    };
  }

  if (result.tool === "git_status") {
    return {
      repoRoot: result.repoRoot,
      branch: result.branch,
      head: result.head,
      hasHead: result.hasHead,
      clean: result.clean,
      fileCount: result.files.length,
      truncated: result.truncated,
    };
  }

  if (result.tool === "git_diff") {
    return {
      repoRoot: result.repoRoot,
      scope: result.scope,
      path: result.path,
      fileCount: result.fileCount,
      truncated: result.truncated,
    };
  }

  if (result.tool === "git_log") {
    return {
      repoRoot: result.repoRoot,
      commitCount: result.commits.length,
      truncated: result.truncated,
    };
  }

  if (result.tool === "git_add") {
    return {
      repoRoot: result.repoRoot,
      stagedPathCount: result.stagedPaths.length,
      postStatusFileCount: result.files.length,
    };
  }

  if (result.tool === "git_commit") {
    return {
      repoRoot: result.repoRoot,
      commit: result.commit.shortSha,
      stagedPathCount: result.stagedPaths.length,
      remainingFileCount: result.remainingFiles.length,
      statLength: result.stat.length,
      nameStatusLength: result.nameStatus.length,
    };
  }

  if (result.tool === "write_file") {
    return {
      hash: result.hash,
      bytesWritten: result.bytesWritten,
      lineCount: result.lineCount,
      bytesChanged: result.bytesChanged,
      lineDelta: result.lineDelta,
      createdParentDirs: result.createdParentDirs,
      kbState: result.kbState,
      writeEvent: result.writeEvent,
    };
  }

  if (result.tool !== "edit_file") {
    return {};
  }

  return {
    beforeHash: result.beforeHash,
    afterHash: result.afterHash,
    bytesChanged: result.bytesChanged,
    firstChangedLine: result.firstChangedLine,
    kbState: result.kbState,
    editEvent: result.editEvent,
  };
}

function countLogicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const withoutTrailingLineEnding = content.replace(/\r?\n$/u, "");

  return withoutTrailingLineEnding.length === 0 ? 1 : withoutTrailingLineEnding.split(/\r?\n/u).length;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
