import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { dryRunKnowledgeCompile, filterNonCleanKnowledgeCompileResult } from "../knowledge/compiler/index.js";
import { type L1FileScanStatus } from "../knowledge/compiler/l1-entry.js";
import { type KnowledgeProgressReporter } from "../knowledge/progress.js";
import { createL1ContextPack, formatL1ContextPackForPrompt } from "../knowledge/search.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";
import { executeSlashCommand, parseSlashCommand } from "./commands.js";
import { type ConversationTurn, buildConversationPrompt } from "./conversation.js";
import { ABORT_CHOICE_VALUE, agentEvent, choiceAction, type AgentRuntimeEvent } from "./events.js";
import { checkAgentReady } from "./health.js";
import { getChatSystemPrompt } from "./prompts.js";
import { createTaskPlanController, hasOpenTaskPlan } from "./task-plan.js";
import {
  executeToolCall,
  isToolErrorResult,
  parseToolCallWithSource,
  toolRegistry,
  type ModelToolCall,
  type ToolCall,
  type ToolExecutionResult,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
  type ToolResult,
} from "./tools.js";
import { type ModelAgentResult } from "../model/index.js";

const MAX_TOOL_CALLS_PER_TURN = 75;

interface TurnTokenUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
}

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

export interface TopchesterAgentRuntimeOptions {
  disableL1Context?: boolean;
}

export class TopchesterAgentRuntime implements AgentRuntime {
  private readonly taskPlan = createTaskPlanController();

  /**
   * Holds the shared application context for one runtime instance.
   * The runtime does not own those dependencies; it coordinates the
   * workspace, model gateway, logger, config, and task-plan state that
   * are passed in by the CLI or TUI layer.
   */
  constructor(
    private readonly context: AppContext,
    private readonly options: TopchesterAgentRuntimeOptions = {}
  ) {}

  /**
   * Performs the lightweight startup model check used by the interactive
   * agent before accepting work. The check is intentionally non-blocking
   * from the user's point of view: timeout and failure both produce a
   * visible status message, but the runtime still moves to ready so the
   * user can continue.
   */
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

  /**
   * Builds the initial knowledge-base status events shown by the TUI.
   * This wraps the raw filesystem status with the same non-clean file count
   * used by `/kb status`, so startup messaging reflects whether project
   * knowledge is ready, missing, stale, or waiting for a sync.
   */
  async checkKnowledgeBase(): Promise<AgentRuntimeEvent[]> {
    return getKnowledgeStatusEvents(await this.getKnowledgeStatusWithNonCleanFileCount());
  }

  /**
   * Runs one user chat turn through the agent loop. It builds the model
   * prompt with relevant KB context, calls the model, executes any requested
   * tools, feeds tool results back into the next prompt, and repeats until
   * the model returns a normal assistant message or the loop hits its safety
   * limit.
   *
   * Events are accumulated for the caller and optionally streamed through
   * `onEvent` as soon as tool calls, task-plan updates, choices, or final
   * messages are available. The method also enforces visible task-plan
   * closure before a final answer when the model leaves an open plan.
   */
  async submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink
  ): Promise<AgentRuntimeEvent[]> {
    const prompt = await this.buildPromptWithKnowledgeContext(buildConversationPrompt(conversation, message), message);
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
    const tokenUsageTotals: TurnTokenUsageTotals = {};
    let lastModelId = "model";
    let afterTool: ToolCall["tool"] | undefined;
    let toolProtocolOverride = readToolProtocolEnvOverride();
    let requestedPlanClosure = false;

    for (let toolCalls = 0; toolCalls <= MAX_TOOL_CALLS_PER_TURN; toolCalls += 1) {
      const startedAt = Date.now();
      const system = getChatSystemPrompt();
      this.context.logger.debug(
        {
          event: "model_prompt",
          purpose: "agent.primary",
          afterTool,
          toolProtocol: toolProtocolOverride,
          promptLength: nextPrompt.length,
          systemLength: system.length,
          prompt: nextPrompt,
          system,
        },
        afterTool ? "model prompt after tool" : "model prompt"
      );
      const result = await generateAgentStep(this.context, {
        purpose: "agent.primary",
        system,
        prompt: nextPrompt,
        abortSignal,
        toolProtocol: toolProtocolOverride,
      });
      const durationMs = Date.now() - startedAt;
      const toolCall = result.toolCalls[0];
      totalDurationMs += durationMs;
      lastModelId = result.modelId;
      addTokenUsageTotals(tokenUsageTotals, result.usage);

      this.context.logger.debug(
        {
          event: "model_response",
          purpose: "agent.primary",
          modelId: result.modelId,
          durationMs,
          totalDurationMs,
          textLength: result.text.length,
          usage: result.usage,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
          costUsd: result.usage?.costUsd,
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
        const plan = this.taskPlan.get();

        if (hasOpenTaskPlan(plan)) {
          if (!requestedPlanClosure) {
            requestedPlanClosure = true;
            nextPrompt = `${nextPrompt}\n\n${formatOpenPlanClosureInstruction(result.text, result.toolProtocol)}`;
            continue;
          }

          await emit(agentEvent.taskPlan(this.taskPlan.update({ items: [] })));
        }

        await emit(
          agentEvent.assistantMessage(
            result.text.trim() || "I got an empty response from the model.",
            formatAgentMessageMeta(result.modelId, totalDurationMs, tokenUsageTotals)
          ),
          agentEvent.status("ready")
        );
        return events;
      }

      if (toolCalls === MAX_TOOL_CALLS_PER_TURN) {
        await emit(
          agentEvent.choice({
            tone: "warning",
            title: "Tool call limit reached",
            body: `Stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn. Continue starts another turn; abort leaves the call stopped.`,
            actions: [
              choiceAction("Continue", "Continue the previous task from where you stopped."),
              choiceAction("Abort", ABORT_CHOICE_VALUE),
            ],
          }),
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
      if (!isToolErrorResult(toolResult) && toolResult.tool === "plan_todo") {
        await emit(agentEvent.taskPlan(toolResult.plan));
      }
      afterTool = executableToolCall.tool;
      nextPrompt = `${nextPrompt}\n\n${formatToolResultForPrompt(toolResult)}\n\n${formatContinuationInstruction(
        result.toolProtocol,
        toolResult
      )}`;
    }

    await emit(
      agentEvent.assistantMessage(
        "I stopped because the tool loop ended unexpectedly.",
        formatAgentMessageMeta(lastModelId, totalDurationMs, tokenUsageTotals)
      ),
      agentEvent.status("ready")
    );

    return events;
  }

  /**
   * Executes a slash command through the shared command dispatcher and maps
   * the command output into runtime events. Commands that can change KB
   * readiness also refresh the displayed knowledge status so the TUI footer
   * and chat status stay aligned with the command result.
   */
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

  /**
   * Reads the project KB status and augments it with a count of files that
   * would be touched by a dry-run compile. The dry run is only performed for
   * a ready KB directory, because missing or incomplete KB states already
   * have enough information for the startup and status messages.
   */
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

  /**
   * Adds relevant L1 knowledge context to the conversation prompt when the
   * compiled KB is present and ready. Search failures are logged and then
   * ignored on purpose: stale or broken KB search should not prevent the
   * user's chat turn from reaching the model.
   */
  private async buildPromptWithKnowledgeContext(prompt: string, message: string): Promise<string> {
    if (this.options.disableL1Context ?? isL1ContextDisabledByEnv()) {
      this.context.logger.debug(
        {
          event: "kb_context_pack_skipped",
          reason: "disabled",
        },
        "kb context pack skipped"
      );

      return prompt;
    }

    const status = getKnowledgeStatus(this.context.workspaceRoot);

    if (!status.kbExists || !status.kbIsDirectory || status.kbContentState !== "ready") {
      return prompt;
    }

    try {
      const contextPack = await createL1ContextPack(this.context.workspaceRoot, message, { limit: 8, minScore: 12 });

      this.context.logger.debug(
        {
          event: "kb_context_pack",
          query: message,
          entryCount: contextPack.entryCount,
          relevantFileCount: contextPack.relevantFiles.length,
          paths: contextPack.relevantFiles.map((file) => file.path),
          warnings: contextPack.warnings,
        },
        "kb context pack"
      );
      this.context.logger.trace(
        {
          event: "kb_context_pack_payload",
          contextPack,
        },
        "kb context pack payload"
      );

      if (contextPack.relevantFiles.length === 0) {
        return prompt;
      }

      return `${formatL1ContextPackForPrompt(contextPack)}\n\nConversation:\n${prompt}`;
    } catch (error) {
      this.context.logger.debug(
        {
          event: "kb_context_pack_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "kb context pack failed"
      );

      return prompt;
    }
  }
}

/**
 * Calls the configured model gateway for a single agent step and normalizes
 * the result into the newer `ModelAgentResult` shape. Gateways that implement
 * native agent stepping receive the tool registry directly; older text-only
 * gateways fall back to parsing a JSON or XML tool call out of the model text
 * so the rest of the runtime can use the same tool loop.
 */
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

/**
 * Reads the optional environment override for the tool-calling protocol.
 * Invalid values are ignored instead of failing startup, which keeps local
 * experimentation contained to supported protocol names while preserving the
 * normal automatic negotiation path by default.
 */
function readToolProtocolEnvOverride(): ToolProtocolOverride | undefined {
  const value = process.env.TOPCHESTER_TOOL_PROTOCOL;

  if (value === "auto" || value === "native" || value === "text-json" || value === "text-xml") {
    return value;
  }

  return undefined;
}

function isL1ContextDisabledByEnv(): boolean {
  const value = process.env.TOPCHESTER_DISABLE_L1_CONTEXT?.trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function shouldShowTokenUsageByEnv(): boolean {
  const value = process.env.TOPCHESTER_SHOW_TOKEN_USAGE?.trim().toLowerCase();

  return value !== undefined && value !== "" && value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

/**
 * Applies TUI styling to per-file KB sync states. The raw scanner statuses
 * are preserved as text, but success, warning, and error categories get
 * different colors so slash-command output is readable without changing the
 * underlying command semantics.
 */
function formatTuiSyncStatus(status: L1FileScanStatus): string {
  if (status === "current") {
    return ui.ok(status);
  }

  if (status === "invalid" || status === "missing_file") {
    return ui.error(status);
  }

  return ui.warn(status);
}

/**
 * Decides whether a slash command should trigger a fresh KB status event.
 * Only KB subcommands that can initialize, rebuild, sync, reset, or inspect
 * the compiled knowledge state need the refresh; other commands can return
 * their output without doing extra filesystem work.
 */
function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "reset", "compile", "sync", "status"].includes(parsed.args[0] ?? "");
}

/**
 * Converts a computed KB status into the startup event shape consumed by the
 * TUI. The event carries both the structured status and a short next-step
 * message, letting renderers show precise state while keeping user-facing
 * guidance in one place.
 */
export function getKnowledgeStatusEvents(status: KnowledgeStatus): AgentRuntimeEvent[] {
  return [agentEvent.knowledgeStatus(status, formatStartupKnowledgeGuidance(status))];
}

/**
 * Produces the short guidance line shown with startup KB status. The message
 * is deliberately action-oriented: it points to the next command that would
 * fix the current state and returns nothing when the KB is ready and clean.
 */
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

/**
 * Serializes a tool execution result into the text that is fed back to the
 * model after a tool call. Each tool gets the metadata the model needs for
 * the next step, such as file hashes, diffs, command exit status, truncation
 * state, or KB dirty-state signals, while errors are presented in a uniform
 * error block.
 */
function formatToolResultForPrompt(result: ToolExecutionResult<ToolResult>): string {
  const path = result.path ? ` ${JSON.stringify(result.path)}` : "";
  const command = result.command ? ` via ${result.command}` : "";
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

/**
 * Builds the follow-up instruction appended after each tool result. It keeps
 * the model on the active task, reminds it to maintain the visible plan, and
 * restates the current tool-call protocol so the next model step remains
 * parseable by the runtime.
 */
function formatContinuationInstruction(protocol: ToolProtocol, result: ToolExecutionResult<ToolResult>): string {
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
    "Update plan_todo after major progress changes.",
    "Before a final answer, close the visible plan by calling plan_todo with all finished items marked completed, or with [] if abandoning the plan.",
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
function formatOpenPlanClosureInstruction(draftAnswer: string, protocol: ToolProtocol): string {
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

/**
 * Formats a compact, user-visible summary for a tool call event. When a
 * result is available the summary includes useful completion details, such as
 * changed-line counts, staged paths, commit subjects, or command failures,
 * instead of echoing the full tool payload.
 */
function formatToolCallMessage(call: ToolCall, result?: ToolExecutionResult<ToolResult>): string {
  if (result && isToolErrorResult(result)) {
    return `${call.tool} failed: ${result.error}`;
  }

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
  if (result?.tool !== "edit_file" || isToolErrorResult(result)) {
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
  if (result?.tool !== "write_file" || isToolErrorResult(result)) {
    return "";
  }

  return ` (${result.writeEvent.writeSummary})`;
}

/**
 * Formats the assistant-message metadata shown next to the final response.
 * The model identifier and cumulative turn duration are kept together here
 * so callers do not need to know how agent-loop timing should be presented.
 */
function formatAgentMessageMeta(model: string, durationMs: number, usage?: TurnTokenUsageTotals): string {
  const tokenUsage = shouldShowTokenUsageByEnv() ? formatTokenUsage(usage) : undefined;

  return [model, formatDuration(durationMs), tokenUsage].filter(Boolean).join(" · ");
}

function addTokenUsageTotals(totals: TurnTokenUsageTotals, usage: ModelAgentResult["usage"]): void {
  if (!usage) {
    return;
  }

  if (typeof usage.inputTokens === "number") {
    totals.inputTokens = (totals.inputTokens ?? 0) + usage.inputTokens;
  }

  if (typeof usage.outputTokens === "number") {
    totals.outputTokens = (totals.outputTokens ?? 0) + usage.outputTokens;
  }
}

function formatTokenUsage(usage: TurnTokenUsageTotals | undefined): string | undefined {
  if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) {
    return undefined;
  }

  return `${formatInteger(usage.inputTokens ?? 0)} input / ${formatInteger(usage.outputTokens ?? 0)} output tokens`;
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
