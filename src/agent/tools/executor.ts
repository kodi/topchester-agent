import { getToolDefinition, type ToolCall, type ToolResult } from "./registry.js";
import { type ToolDefinition, type ToolContext } from "./types.js";
import { type Logger } from "pino";

export interface ExecuteToolCallOptions {
  pathEnv?: string;
  logger?: Logger;
}

type RuntimeToolDefinition = ToolDefinition<string, unknown, ToolResult>;

export async function executeToolCall(
  workspaceRoot: string,
  call: ToolCall,
  options: ExecuteToolCallOptions = {}
): Promise<ToolResult> {
  const definition = getToolDefinition(call.tool) as RuntimeToolDefinition;
  const startedAt = Date.now();
  const context: ToolContext = {
    workspaceRoot,
    pathEnv: options.pathEnv,
    logger: options.logger,
  };

  options.logger?.debug({ event: "tool_call", tool: call.tool, args: summarizeToolArgs(call) }, "tool call");

  try {
    const result = await definition.execute(context, call.args);
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
    options.logger?.error(
      {
        event: "tool_error",
        tool: call.tool,
        durationMs: Date.now() - startedAt,
        err: error,
      },
      "tool failed"
    );
    throw error;
  }
}

function summarizeToolArgs(call: ToolCall): unknown {
  if (call.tool === "write_file") {
    return {
      path: call.args.path,
      contentLength: call.args.content.length,
      lineCount: countLogicalLines(call.args.content),
      createParentDirs: Boolean(call.args.create_parent_dirs),
      overwrite: Boolean(call.args.overwrite),
      expectedHashProvided: Boolean(call.args.expected_hash),
    };
  }

  if (call.tool !== "edit_file") {
    return call.args;
  }

  return {
    path: call.args.path,
    editCount: call.args.edits.length,
    oldTextLengths: call.args.edits.map((edit) => edit.old_text.length),
    newTextLengths: call.args.edits.map((edit) => edit.new_text.length),
    expectedHashProvided: Boolean(call.args.expected_hash),
  };
}

function summarizeToolResult(result: ToolResult): Record<string, unknown> {
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
