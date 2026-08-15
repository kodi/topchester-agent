import { isToolAllowed, type AgentProfile, type ToolPermissionView } from "../profiles.js";
import { type AgentRuntimeEvent } from "../events.js";
import { type SubagentManager } from "../subagents.js";
import { isToolName, type ToolCall as StaticToolCall, type ToolResult as StaticToolResult } from "./registry.js";
import { getStaticOrCatalogToolDefinition, isCatalogToolAllowed, type ToolCatalog } from "./catalog.js";
import { type ToolCall, type ToolContext, type ToolExecutionResult, type ToolResult } from "./types.js";
import { type Logger } from "pino";
import { type TaskPlanController } from "../task-plan.js";
import { type TopchesterConfig } from "../../config/index.js";
import { type BenchmarkProfile } from "../benchmark-profile.js";

export interface ExecuteToolCallOptions {
  pathEnv?: string;
  bashApprovals?: ToolContext["bashApprovals"];
  logger?: Logger;
  config?: TopchesterConfig;
  taskPlan?: TaskPlanController;
  profile?: AgentProfile;
  permissions?: ToolPermissionView;
  subagents?: SubagentManager;
  projectInstructions?: ToolContext["projectInstructions"];
  currentUserMessage?: string;
  benchmarkProfile?: BenchmarkProfile;
  readFileCache?: ToolContext["readFileCache"];
  eventSink?: (event: AgentRuntimeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  sessionId?: string;
  rootSessionId?: string;
  turnId?: string;
  toolCatalog?: ToolCatalog;
}

export function executeToolCall(
  workspaceRoot: string,
  call: StaticToolCall,
  options?: ExecuteToolCallOptions
): Promise<ToolExecutionResult<StaticToolResult>>;
export function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions & { toolCatalog: ToolCatalog }
): Promise<ToolExecutionResult<ToolResult>>;
export async function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions = {}
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const context: ToolContext = {
    workspaceRoot,
    pathEnv: options.pathEnv,
    bashApprovals: options.bashApprovals,
    logger: options.logger,
    config: options.config,
    taskPlan: options.taskPlan,
    profile: options.profile,
    permissions: options.permissions,
    subagents: options.subagents,
    projectInstructions: options.projectInstructions,
    currentUserMessage: options.currentUserMessage,
    benchmarkProfile: options.benchmarkProfile,
    readFileCache: options.readFileCache,
    eventSink: options.eventSink,
    abortSignal: options.abortSignal,
    toolCallId: options.toolCallId,
  };

  try {
    const definition = getStaticOrCatalogToolDefinition(options.toolCatalog, call.tool);

    if (!definition) {
      throw new Error(`Unknown tool "${call.tool}".`);
    }

    if (options.permissions && !isToolExecutionAllowed(options.toolCatalog, options.permissions, call.tool)) {
      throw new Error(`Tool "${call.tool}" is not allowed for agent profile "${options.permissions.profileId}".`);
    }

    const parsedCall = { ...call, args: definition.argsSchema.parse(call.args) } as ToolCall;

    options.logger?.debug(
      {
        event: "tool_call",
        tool: parsedCall.tool,
        toolCallId: options.toolCallId,
        sessionId: options.sessionId,
        rootSessionId: options.rootSessionId,
        turnId: options.turnId,
        args: summarizeToolArgs(parsedCall),
      },
      "tool call"
    );

    const result = await definition.execute(context, parsedCall.args);
    const durationMs = Date.now() - startedAt;

    options.logger?.debug(
      {
        event: "tool_result",
        tool: result.tool,
        toolCallId: options.toolCallId,
        sessionId: options.sessionId,
        rootSessionId: options.rootSessionId,
        turnId: options.turnId,
        path: result.path,
        command: "command" in result ? result.command : undefined,
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
      toolCallId: options.toolCallId,
      sessionId: options.sessionId,
      rootSessionId: options.rootSessionId,
      turnId: options.turnId,
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

function isToolExecutionAllowed(
  catalog: ToolCatalog | undefined,
  permissionView: ToolPermissionView,
  toolName: string
): boolean {
  return catalog
    ? isCatalogToolAllowed(catalog, permissionView, toolName)
    : isToolName(toolName) && isToolAllowed(permissionView, toolName);
}

function summarizeToolArgs(call: ToolCall<string, any>): unknown {
  if (call.tool === "plan_todo") {
    const activeItem = call.args.items.find(
      (item: { status?: string; text?: string }) => item.status === "in_progress"
    )?.text;

    return {
      itemCount: call.args.items.length,
      activeItem,
      completedCount: call.args.items.filter((item: { status?: string }) => item.status === "completed").length,
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
    if (call.tool === "web_fetch") {
      return {
        url: call.args.url,
        format: call.args.format,
        timeoutSeconds: call.args.timeout_seconds,
      };
    }

    if (call.tool === "bash") {
      return {
        command: call.args.command,
        workdir: call.args.workdir,
        timeoutMs: call.args.timeout_ms,
      };
    }

    return call.args;
  }

  return {
    path: call.args.path,
    editCount: call.args.edits.length,
    oldTextLengths: call.args.edits.map((edit: { old_text: string }) => edit.old_text.length),
    newTextLengths: call.args.edits.map((edit: { new_text: string }) => edit.new_text.length),
    expectedCurrentHashProvided: Boolean(call.args.expected_current_hash),
  };
}

function summarizeToolResult(result: any): Record<string, unknown> {
  if (result.tool === "plan_todo") {
    return {
      itemCount: result.plan.items.length,
      activeItem: result.currentItem,
      completedCount: result.completedCount,
    };
  }

  if (result.tool === "web_fetch") {
    return {
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType: result.contentType,
      truncated: result.truncated,
      redirectedTo: result.redirectedTo,
      bytes: result.bytes,
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

  if (result.tool === "bash") {
    return {
      cwd: result.cwd,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: result.aborted,
      truncated: result.truncated,
      shell: result.shell,
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
    if (!("hash" in result)) {
      return {};
    }

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

  if (result.tool !== "edit_file" || !("editEvent" in result)) {
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
