import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { dryRunKnowledgeCompile, filterNonCleanKnowledgeCompileResult } from "../knowledge/compiler/index.js";
import { type L1FileScanStatus } from "../knowledge/compiler/l1-entry.js";
import { type KnowledgeProgressReporter } from "../knowledge/progress.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";
import { executeSlashCommand, parseSlashCommand } from "./commands.js";
import { type ConversationTurn, buildConversationPrompt } from "./conversation.js";
import { agentEvent, type AgentRuntimeEvent } from "./events.js";
import { checkAgentReady } from "./health.js";
import { getChatSystemPrompt } from "./prompts.js";
import { createTaskPlanController } from "./task-plan.js";
import {
  executeToolCall,
  parseToolCallWithSource,
  toolRegistry,
  type ModelToolCall,
  type ToolCall,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
  type ToolResult,
} from "./tools.js";
import { type ModelAgentResult } from "../model/index.js";

const MAX_TOOL_CALLS_PER_TURN = 8;

export interface AgentRuntime {
  checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]>;
  checkKnowledgeBase(): Promise<AgentRuntimeEvent[]>;
  submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink
  ): Promise<AgentRuntimeEvent[]>;
  submitSlashCommand(command: string, onProgress?: KnowledgeProgressReporter): Promise<AgentRuntimeEvent[]>;
}

export type AgentRuntimeEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

export class TopchesterAgentRuntime implements AgentRuntime {
  private readonly taskPlan = createTaskPlanController();

  constructor(private readonly context: AppContext) {}

  async checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]> {
    const result = await checkAgentReady(this.context.modelGateway, abortSignal);

    if (result === "ready") {
      return [agentEvent.status("ready")];
    }

    if (result === "timed-out") {
      return [
        agentEvent.systemMessage("Agent is taking a while, so I skipped the startup check."),
        agentEvent.status("ready"),
      ];
    }

    return [agentEvent.systemMessage("Agent did not say it was ready."), agentEvent.status("ready")];
  }

  async checkKnowledgeBase(): Promise<AgentRuntimeEvent[]> {
    return getKnowledgeStatusEvents(await this.getKnowledgeStatusWithNonCleanFileCount());
  }

  async submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink
  ): Promise<AgentRuntimeEvent[]> {
    const prompt = buildConversationPrompt(conversation, message);
    const events: AgentRuntimeEvent[] = [];
    const emit = async (...nextEvents: AgentRuntimeEvent[]) => {
      events.push(...nextEvents);

      if (!onEvent) {
        return;
      }

      for (const event of nextEvents) {
        await onEvent(event);
      }
    };
    let nextPrompt = prompt;
    let totalDurationMs = 0;
    let lastModelId = "model";
    let afterTool: ToolCall["tool"] | undefined;
    let toolProtocolOverride = readToolProtocolEnvOverride();

    for (let toolCalls = 0; toolCalls <= MAX_TOOL_CALLS_PER_TURN; toolCalls += 1) {
      const startedAt = Date.now();
      const result = await generateAgentStep(this.context, {
        purpose: "agent.primary",
        system: getChatSystemPrompt(),
        prompt: nextPrompt,
        abortSignal,
        toolProtocol: toolProtocolOverride,
      });
      const durationMs = Date.now() - startedAt;
      const toolCall = result.toolCalls[0];
      totalDurationMs += durationMs;
      lastModelId = result.modelId;

      this.context.logger.debug(
        {
          event: "model_response",
          purpose: "agent.primary",
          modelId: result.modelId,
          durationMs,
          totalDurationMs,
          textLength: result.text.length,
          hasToolCall: Boolean(toolCall),
          toolProtocol: result.toolProtocol,
          protocolAttempts: result.protocolAttempts,
          toolCallSource: toolCall?.source,
          fallbackReason: result.fallbackReason,
          providerRejectedTools: result.providerRejectedTools,
          openRouterRoutingApplied: result.openRouterRoutingApplied,
          afterTool,
        },
        afterTool ? "model response after tool" : "model response"
      );
      this.context.logger.trace(
        {
          event: "model_response_text",
          purpose: "agent.primary",
          modelId: result.modelId,
          afterTool,
          toolProtocol: result.toolProtocol,
          text: result.text,
        },
        afterTool ? "model response text after tool" : "model response text"
      );

      if (result.providerRejectedTools && result.toolProtocol === "text-json") {
        toolProtocolOverride = "text-json";
      } else if (result.providerRejectedTools && result.toolProtocol === "text-xml") {
        toolProtocolOverride = "text-xml";
      }

      if (!toolCall) {
        await emit(
          agentEvent.assistantMessage(
            result.text.trim() || "I got an empty response from the model.",
            formatAgentMessageMeta(result.modelId, totalDurationMs)
          ),
          agentEvent.status("ready")
        );
        return events;
      }

      if (toolCalls === MAX_TOOL_CALLS_PER_TURN) {
        await emit(
          agentEvent.systemMessage(`Stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn.`),
          agentEvent.status("ready")
        );
        return events;
      }

      const executableToolCall = toolCall as ToolCall;
      const toolResult = await executeToolCall(this.context.workspaceRoot, executableToolCall, {
        logger: this.context.logger,
        taskPlan: this.taskPlan,
      });
      await emit(agentEvent.toolCall(executableToolCall, formatToolCallMessage(executableToolCall, toolResult)));
      if (toolResult.tool === "plan_todo") {
        await emit(agentEvent.taskPlan(toolResult.plan));
      }
      afterTool = executableToolCall.tool;
      nextPrompt = `${nextPrompt}\n\n${formatToolResultForPrompt(toolResult)}\n\n${formatContinuationInstruction(result.toolProtocol)}`;
    }

    await emit(
      agentEvent.assistantMessage(
        "I stopped because the tool loop ended unexpectedly.",
        formatAgentMessageMeta(lastModelId, totalDurationMs)
      ),
      agentEvent.status("ready")
    );

    return events;
  }

  async submitSlashCommand(command: string, onProgress?: KnowledgeProgressReporter): Promise<AgentRuntimeEvent[]> {
    const result = await executeSlashCommand(command, {
      workspaceRoot: this.context.workspaceRoot,
      config: this.context.config,
      modelGateway: this.context.modelGateway,
      onProgress,
      formatSyncStatus: formatTuiSyncStatus,
    });
    const events: AgentRuntimeEvent[] = [agentEvent.systemMessage(result.messages.join("\n"))];

    if (shouldRefreshKnowledgeStatus(command)) {
      events.push(agentEvent.knowledgeStatus(await this.getKnowledgeStatusWithNonCleanFileCount()));
    }

    events.push(agentEvent.status("ready"));

    return events;
  }

  private async getKnowledgeStatusWithNonCleanFileCount(): Promise<KnowledgeStatus> {
    const status = getKnowledgeStatus(this.context.workspaceRoot);

    if (!status.kbExists || !status.kbIsDirectory || status.kbContentState !== "ready") {
      return status;
    }

    const result = filterNonCleanKnowledgeCompileResult(
      await dryRunKnowledgeCompile(this.context.workspaceRoot, { config: this.context.config })
    );

    return { ...status, nonCleanFileCount: result.files.length };
  }
}

async function generateAgentStep(
  context: AppContext,
  request: {
    purpose: "agent.primary";
    system: string;
    prompt: string;
    abortSignal?: AbortSignal;
    toolProtocol?: ToolProtocolOverride;
  }
): Promise<ModelAgentResult> {
  if ("generateAgentStep" in context.modelGateway && typeof context.modelGateway.generateAgentStep === "function") {
    return context.modelGateway.generateAgentStep({
      ...request,
      tools: Object.values(toolRegistry),
    });
  }

  const result = await context.modelGateway.generateText(request);
  const parsed = parseToolCallWithSource(result.text);
  const toolProtocol: ToolProtocol = parsed?.source === "text-xml" ? "text-xml" : "text-json";
  const attempts: ToolProtocolAttempt[] = [{ protocol: toolProtocol, status: "used", reason: "legacy gateway" }];

  return {
    ...result,
    toolCalls: parsed
      ? [
          {
            id: `${parsed.source}-0`,
            tool: parsed.call.tool,
            args: parsed.call.args,
            source: parsed.source,
          } as ModelToolCall,
        ]
      : [],
    toolProtocol,
    protocolAttempts: attempts,
    providerRejectedTools: false,
    warnings: [],
    openRouterRoutingApplied: false,
  };
}

function readToolProtocolEnvOverride(): ToolProtocolOverride | undefined {
  const value = process.env.TOPCHESTER_TOOL_PROTOCOL;

  if (value === "auto" || value === "native" || value === "text-json" || value === "text-xml") {
    return value;
  }

  return undefined;
}

function formatTuiSyncStatus(status: L1FileScanStatus): string {
  if (status === "current") {
    return ui.ok(status);
  }

  if (status === "invalid" || status === "missing_file") {
    return ui.error(status);
  }

  return ui.warn(status);
}

function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "reset", "compile", "sync", "status"].includes(parsed.args[0] ?? "");
}

export function getKnowledgeStatusEvents(status: KnowledgeStatus): AgentRuntimeEvent[] {
  return [agentEvent.knowledgeStatus(status, formatStartupKnowledgeGuidance(status))];
}

function formatStartupKnowledgeGuidance(status: KnowledgeStatus): string | undefined {
  if (!status.kbExists) {
    return "Next: run /kb init, then /kb compile to create project knowledge.";
  }

  if (!status.kbIsDirectory) {
    return "Fix the KB path or config, then run /kb status.";
  }

  if (status.kbContentState !== "ready") {
    return "Next: run /kb compile to build project knowledge.";
  }

  if ((status.nonCleanFileCount ?? 0) > 0) {
    return "Next: run /kb sync to update project knowledge, or /kb status to inspect the files.";
  }

  return undefined;
}

function formatToolResultForPrompt(result: ToolResult): string {
  const path = result.path ? ` ${JSON.stringify(result.path)}` : "";
  const command = result.command ? ` via ${result.command}` : "";
  const warning = result.warning ? `\nWarning: ${result.warning}` : "";

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

  if (result.tool === "edit_file") {
    return [
      `Tool result from ${result.tool}${path}:`,
      `before_hash: ${result.beforeHash}`,
      `after_hash: ${result.afterHash}`,
      `kb_state: ${result.kbState}`,
      `bytes_changed: ${result.bytesChanged}`,
      `first_changed_line: ${result.firstChangedLine}`,
      "```diff",
      result.diff,
      "```",
    ].join("\n");
  }

  if (result.tool === "write_file") {
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

function formatContinuationInstruction(protocol: ToolProtocol): string {
  const toolInstruction =
    protocol === "text-xml"
      ? "If another tool is needed, reply with only one XML tool call."
      : protocol === "text-json"
        ? "If another tool is needed, reply with only that tool JSON."
        : "If another tool is needed, use the available tool calling path.";

  return `Continue the user's request using the tool result above and the visible plan when one is active. Update plan_todo after major progress changes. ${toolInstruction} Otherwise answer the user. Do not guess.`;
}

function formatToolCallMessage(call: ToolCall, result?: ToolResult): string {
  switch (call.tool) {
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
  }
}

function formatGitDiffCallSummary(call: Extract<ToolCall, { tool: "git_diff" }>, result?: ToolResult): string {
  if (result?.tool === "git_diff") {
    return `${result.scope} (${result.fileCount} files${result.truncated ? ", truncated" : ""})`;
  }

  return call.args.scope;
}

function formatEditFileChangeSummary(result: ToolResult | undefined): string {
  if (result?.tool !== "edit_file") {
    return "";
  }

  return ` (changed ${result.editEvent.diffSummary})`;
}

function formatWriteFileChangeSummary(result: ToolResult | undefined): string {
  if (result?.tool !== "write_file") {
    return "";
  }

  return ` (${result.writeEvent.writeSummary})`;
}

function formatAgentMessageMeta(model: string, durationMs: number): string {
  return `${model} · ${formatDuration(durationMs)}`;
}

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

function formatNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
