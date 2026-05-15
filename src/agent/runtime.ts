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
import {
  createToolPermissionView,
  getProfileToolDefinitions,
  isToolAllowed,
  PRIMARY_AGENT_PROFILE,
  type AgentProfile,
  type ToolPermissionView,
} from "./profiles.js";
import { getChatSystemPrompt } from "./prompts.js";
import { SubagentManager } from "./subagents.js";
import { createTaskPlanController, hasOpenTaskPlan, type TaskPlanState } from "./task-plan.js";
import { type SessionHandle } from "../session/store.js";
import { type ModelAgentResult, type ModelReasoningSink } from "../model/index.js";
import {
  executeToolCall,
  isParallelSafeToolName,
  isToolErrorResult,
  parseToolCallRejection,
  parseToolCallWithSource,
  runCommandArgsSchema,
  type ModelToolCall,
  type ToolCall,
  type ToolCallParseRejection,
  type ToolCallSource,
  type ToolExecutionResult,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
  type ToolResult,
} from "./tools.js";
import { validateRunCommandPolicy } from "./tools/command-policy.js";

const MAX_TOOL_CALLS_PER_TURN = 75;
const DEFAULT_TASK_CONCURRENCY = 3;

interface TurnTokenUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentRuntime {
  checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]>;
  checkKnowledgeBase(): Promise<AgentRuntimeEvent[]>;
  submitMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    options?: AgentRuntimeSubmitMessageOptions
  ): AsyncIterable<AgentRuntimeEvent>;
  submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink,
    options?: AgentRuntimeSubmitMessageOptions
  ): Promise<AgentRuntimeEvent[]>;
  submitSlashCommand(command: string, onProgress?: KnowledgeProgressReporter): Promise<AgentRuntimeEvent[]>;
}

export type AgentRuntimeEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

export interface AgentRuntimeSubmitMessageOptions {
  onReasoning?: ModelReasoningSink;
  session?: SessionHandle;
  requestRunCommandApproval?: (request: RunCommandApprovalRequest) => Promise<RunCommandApprovalDecision>;
}

export interface RunCommandApprovalRequest {
  command: string;
  workdir: string;
  reason: string;
}

export type RunCommandApprovalDecision = "run_once" | "allow_session" | "allow_repo" | "cancel";

export interface TopchesterAgentRuntimeOptions {
  disableL1Context?: boolean;
  profile?: AgentProfile;
  parentPermissions?: ToolPermissionView;
  session?: SessionHandle;
}

export class TopchesterAgentRuntime implements AgentRuntime {
  private readonly taskPlan = createTaskPlanController();
  private readonly approvedRunCommands = new Set<string>();

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
   * Streams one user chat turn through the agent loop. It builds the model
   * prompt with relevant KB context, calls the model, executes any requested
   * tools, feeds tool results back into the next prompt, and repeats until
   * the model returns a normal assistant message or the loop hits its safety
   * limit.
   *
   * This is the primary runtime execution contract. Compatibility wrappers
   * can collect the stream, but the runtime's own turn loop only knows about
   * ordered events.
   */
  async *submitMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    options: AgentRuntimeSubmitMessageOptions = {}
  ): AsyncIterable<AgentRuntimeEvent> {
    const prompt = await this.buildPromptWithKnowledgeContext(buildConversationPrompt(conversation, message), message);
    let nextPrompt = prompt;
    let totalDurationMs = 0;
    const tokenUsageTotals: TurnTokenUsageTotals = {};
    const profile = this.options.profile ?? PRIMARY_AGENT_PROFILE;
    const permissions = createToolPermissionView(profile, {
      deniedTools: this.options.parentPermissions?.deniedTools,
    });
    const tools = getProfileToolDefinitions(permissions);
    const session = options.session ?? this.options.session;
    const subagents = new SubagentManager({
      context: this.context,
      parentSession: session,
      parentProfile: profile,
      parentPermissions: permissions,
      createRuntime: ({ profile: childProfile, parentPermissions, session: childSession }) =>
        new TopchesterAgentRuntime(this.context, {
          ...this.options,
          profile: childProfile,
          parentPermissions,
          session: childSession,
        }),
    });
    let lastModelId = "model";
    let afterTool: ToolCall["tool"] | undefined;
    let toolProtocolOverride = readToolProtocolEnvOverride();
    let requestedPlanClosure = false;
    let invalidToolCallRepairs = 0;

    for (let toolCalls = 0; toolCalls <= MAX_TOOL_CALLS_PER_TURN; toolCalls += 1) {
      const startedAt = Date.now();
      const system = getChatSystemPrompt({ profile, permissions });
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
        onReasoning: options.onReasoning,
        tools,
      });
      const durationMs = Date.now() - startedAt;
      const modelToolCalls = getExecutableModelToolCalls(result);
      const toolCall = modelToolCalls[0];
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
        const rejectedToolCall = parseToolCallRejection(result.text, getTextToolCallSources(result.toolProtocol));

        if (rejectedToolCall && invalidToolCallRepairs < 2) {
          invalidToolCallRepairs += 1;
          this.context.logger.debug(
            {
              event: "invalid_text_tool_call",
              purpose: "agent.primary",
              tool: rejectedToolCall.tool,
              reason: rejectedToolCall.reason,
              source: rejectedToolCall.source,
              afterTool,
            },
            "invalid text tool call"
          );
          nextPrompt = `${nextPrompt}\n\n${formatInvalidToolCallRepairInstruction(rejectedToolCall)}`;
          continue;
        }

        const plan = this.taskPlan.get();
        const finalText = stripSuppressiblePlanTodoPrefix(result.text, plan) ?? result.text;

        if (hasOpenTaskPlan(plan)) {
          if (!requestedPlanClosure) {
            requestedPlanClosure = true;
            nextPrompt = `${nextPrompt}\n\n${formatOpenPlanClosureInstruction(finalText, result.toolProtocol)}`;
            continue;
          }

          yield agentEvent.taskPlan(this.taskPlan.update({ items: [] }));
        }

        yield agentEvent.assistantMessage(
          finalText.trim() || "I got an empty response from the model.",
          formatAgentMessageMeta(result.modelId, totalDurationMs, tokenUsageTotals)
        );
        yield agentEvent.status("ready");
        return;
      }

      if (toolCalls === MAX_TOOL_CALLS_PER_TURN) {
        yield agentEvent.choice({
          tone: "warning",
          title: "Tool call limit reached",
          body: `Stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn. Continue starts another turn; abort leaves the call stopped.`,
          actions: [
            choiceAction("Continue", "Continue the previous task from where you stopped."),
            choiceAction("Abort", ABORT_CHOICE_VALUE),
          ],
        });
        yield agentEvent.status("ready");
        return;
      }

      if (modelToolCalls.length > 1 && modelToolCalls.every((call) => call.tool === "task")) {
        const taskCalls = modelToolCalls.map((call) => call as ToolCall);
        const taskResults: ToolExecutionResult<ToolResult>[] = [];

        for (let index = 0; index < taskCalls.length; index += DEFAULT_TASK_CONCURRENCY) {
          const batch = taskCalls.slice(index, index + DEFAULT_TASK_CONCURRENCY);
          const taskEventQueue = createRuntimeEventQueue();
          const batchResultPromise = Promise.all(
            batch.map((call, batchIndex) =>
              executeToolCall(this.context.workspaceRoot, call, {
                logger: this.context.logger,
                config: this.context.config,
                taskPlan: this.taskPlan,
                profile,
                permissions,
                subagents,
                abortSignal,
                toolCallId: modelToolCalls[index + batchIndex]?.id,
                eventSink: (event) => taskEventQueue.push(event),
              })
            )
          ).finally(() => {
            taskEventQueue.close();
          });

          for await (const event of taskEventQueue) {
            yield event;
          }

          taskResults.push(...(await batchResultPromise));
        }

        for (let index = 0; index < taskCalls.length; index += 1) {
          yield agentEvent.toolCall(taskCalls[index]!, formatToolCallMessage(taskCalls[index]!, taskResults[index]));
        }

        afterTool = "task";
        nextPrompt = `${nextPrompt}\n\n${taskResults
          .map((toolResult) => formatToolResultForPrompt(toolResult))
          .join("\n\n")}\n\n${formatContinuationInstruction(
          result.toolProtocol,
          taskResults.at(-1)!,
          isToolAllowed(permissions, "plan_todo")
        )}`;
        continue;
      }

      if (modelToolCalls.length > 1 && modelToolCalls.every((call) => isParallelSafeToolName(call.tool))) {
        const parallelCalls = modelToolCalls.map((call) => call as ToolCall);
        const parallelResults = await Promise.all(
          parallelCalls.map((call, index) =>
            executeToolCall(this.context.workspaceRoot, call, {
              logger: this.context.logger,
              config: this.context.config,
              taskPlan: this.taskPlan,
              profile,
              permissions,
              subagents,
              abortSignal,
              toolCallId: modelToolCalls[index]?.id,
            })
          )
        );

        for (let index = 0; index < parallelCalls.length; index += 1) {
          yield agentEvent.toolCall(
            parallelCalls[index]!,
            formatToolCallMessage(parallelCalls[index]!, parallelResults[index])
          );
        }

        afterTool = parallelCalls.at(-1)?.tool;
        nextPrompt = `${nextPrompt}\n\n${parallelResults
          .map((toolResult) => formatToolResultForPrompt(toolResult))
          .join("\n\n")}\n\n${formatContinuationInstruction(
          result.toolProtocol,
          parallelResults.at(-1)!,
          isToolAllowed(permissions, "plan_todo")
        )}`;
        continue;
      }

      const executableToolCall = toolCall as ToolCall;
      const suppressiblePlanTodoAnswer = getSuppressiblePlanTodoAnswer(
        executableToolCall,
        result.text,
        this.taskPlan.get()
      );

      if (suppressiblePlanTodoAnswer !== undefined) {
        yield agentEvent.assistantMessage(
          suppressiblePlanTodoAnswer || "I got an empty response from the model.",
          formatAgentMessageMeta(result.modelId, totalDurationMs, tokenUsageTotals)
        );
        yield agentEvent.status("ready");
        return;
      }

      const approval = await this.resolveRunCommandApproval(executableToolCall, options);
      let toolResult: ToolExecutionResult<ToolResult>;

      if (approval.cancelled) {
        toolResult = createToolErrorResult(executableToolCall.tool, approval.reason);
      } else {
        const toolEventQueue = createRuntimeEventQueue();
        const toolResultPromise = executeToolCall(this.context.workspaceRoot, executableToolCall, {
          logger: this.context.logger,
          config: this.context.config,
          runCommandApprovals: { allowExactCommands: approval.approvedCommands },
          taskPlan: this.taskPlan,
          profile,
          permissions,
          subagents,
          abortSignal,
          toolCallId: toolCall.id,
          eventSink: (event) => toolEventQueue.push(event),
        }).finally(() => {
          toolEventQueue.close();
        });

        for await (const event of toolEventQueue) {
          yield event;
        }

        toolResult = await toolResultPromise;
      }

      yield agentEvent.toolCall(executableToolCall, formatToolCallMessage(executableToolCall, toolResult));
      if (!isToolErrorResult(toolResult) && toolResult.tool === "plan_todo") {
        yield agentEvent.taskPlan(toolResult.plan);
      }
      afterTool = executableToolCall.tool;
      nextPrompt = `${nextPrompt}\n\n${formatToolResultForPrompt(toolResult)}\n\n${formatContinuationInstruction(
        result.toolProtocol,
        toolResult,
        isToolAllowed(permissions, "plan_todo")
      )}`;
    }

    yield agentEvent.assistantMessage(
      "I stopped because the tool loop ended unexpectedly.",
      formatAgentMessageMeta(lastModelId, totalDurationMs, tokenUsageTotals)
    );
    yield agentEvent.status("ready");
  }

  /**
   * Compatibility wrapper for callers that still expect a completed event
   * array or use the older `onEvent` callback shape.
   */
  async submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink,
    options: AgentRuntimeSubmitMessageOptions = {}
  ): Promise<AgentRuntimeEvent[]> {
    const events: AgentRuntimeEvent[] = [];

    for await (const event of this.submitMessageStream(conversation, message, abortSignal, options)) {
      events.push(event);
      await onEvent?.(event);
    }

    return events;
  }

  private async resolveRunCommandApproval(
    call: ToolCall,
    options: AgentRuntimeSubmitMessageOptions
  ): Promise<{ cancelled: false; approvedCommands: string[] } | { cancelled: true; reason: string }> {
    const approvedCommands = [...this.approvedRunCommands];

    if (call.tool !== "run_command") {
      return { cancelled: false, approvedCommands };
    }

    const parsed = runCommandArgsSchema.safeParse(call.args);

    if (!parsed.success) {
      return { cancelled: false, approvedCommands };
    }

    const decision = await validateRunCommandPolicy(parsed.data, {
      workspaceRoot: this.context.workspaceRoot,
      commands: this.context.config.tools?.commands,
      approvedCommands,
    });

    if (decision.allowed) {
      return { cancelled: false, approvedCommands };
    }

    if (!isRunCommandApprovalEligible(decision.reason) || !options.requestRunCommandApproval) {
      return { cancelled: false, approvedCommands };
    }

    const command = decision.commands[0] ?? parsed.data.command.trim();
    const approval = await options.requestRunCommandApproval({
      command,
      workdir: parsed.data.workdir,
      reason: decision.reason,
    });

    if (approval === "cancel") {
      return {
        cancelled: true,
        reason: `run_command cancelled by user for '${command}'.`,
      };
    }

    if (approval === "allow_session" || approval === "allow_repo") {
      this.approvedRunCommands.add(command);
      return { cancelled: false, approvedCommands: [...this.approvedRunCommands] };
    }

    return { cancelled: false, approvedCommands: [...approvedCommands, command] };
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

interface RuntimeEventQueue {
  push(event: AgentRuntimeEvent): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent>;
}

function createRuntimeEventQueue(): RuntimeEventQueue {
  const events: AgentRuntimeEvent[] = [];
  let closed = false;
  let notify: (() => void) | undefined;

  return {
    push(event) {
      events.push(event);
      notify?.();
      notify = undefined;
    },

    close() {
      closed = true;
      notify?.();
      notify = undefined;
    },

    async *[Symbol.asyncIterator]() {
      while (!closed || events.length > 0) {
        const event = events.shift();
        if (event) {
          yield event;
          continue;
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

function isRunCommandApprovalEligible(reason: string): boolean {
  return reason.endsWith("because it is not a validator or configured command.");
}

function createToolErrorResult(tool: ToolCall["tool"], message: string): ToolExecutionResult<ToolResult> {
  return {
    tool,
    content: `Tool ${tool} failed: ${message}`,
    error: message,
    warning: message,
  };
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
    onReasoning?: ModelReasoningSink;
    tools: ReturnType<typeof getProfileToolDefinitions>;
  }
): Promise<ModelAgentResult> {
  if ("generateAgentStep" in context.modelGateway && typeof context.modelGateway.generateAgentStep === "function") {
    return context.modelGateway.generateAgentStep({
      ...request,
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

function getExecutableModelToolCalls(result: ModelAgentResult): ModelToolCall[] {
  if (result.toolCalls.length > 0) {
    return result.toolCalls;
  }

  const allowedSources =
    result.toolProtocol === "text-xml"
      ? (["text-xml"] as const)
      : result.toolProtocol === "text-json"
        ? (["text-json"] as const)
        : (["text-json", "text-xml"] as const);
  const parsed = parseToolCallWithSource(result.text, allowedSources);

  if (!parsed) {
    return [];
  }

  return [
    {
      id: `${parsed.source}-runtime-recovered-0`,
      tool: parsed.call.tool,
      args: parsed.call.args,
      source: parsed.source,
    } as ModelToolCall,
  ];
}

function getSuppressiblePlanTodoAnswer(
  call: ToolCall,
  modelText: string,
  currentPlan: TaskPlanState
): string | undefined {
  if (call.tool !== "plan_todo" || hasOpenTaskPlan(currentPlan)) {
    return undefined;
  }

  const items = (call.args as { items?: unknown }).items;

  if (!Array.isArray(items) || items.some((item) => !isCompletedPlanTodoItem(item))) {
    return undefined;
  }

  const parsed = parseToolCallWithSource(modelText, ["text-json"]);

  return parsed?.remainder ? parsed.remainder : undefined;
}

function stripSuppressiblePlanTodoPrefix(modelText: string, currentPlan: TaskPlanState): string | undefined {
  const parsed = parseToolCallWithSource(modelText, ["text-json"]);

  if (!parsed) {
    return undefined;
  }

  return getSuppressiblePlanTodoAnswer(parsed.call, modelText, currentPlan);
}

function isCompletedPlanTodoItem(item: unknown): boolean {
  return Boolean(
    item && typeof item === "object" && "status" in item && (item as { status?: unknown }).status === "completed"
  );
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
 * Only KB subcommands that can initialize, sync, reset, or inspect
 * the compiled knowledge state need the refresh; other commands can return
 * their output without doing extra filesystem work.
 */
function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "reset", "sync", "status"].includes(parsed.args[0] ?? "");
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
    return "Next: run /kb init, then /kb sync to create project knowledge.";
  }

  if (!status.kbIsDirectory) {
    return "Fix the KB path or config, then run /kb status.";
  }

  if (status.kbContentState !== "ready") {
    return "Next: run /kb sync to build project knowledge.";
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

  if (result.tool === "task") {
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

  if (result.tool === "run_command") {
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
function formatContinuationInstruction(
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

function formatInvalidToolCallRepairInstruction(rejection: ToolCallParseRejection): string {
  return [
    `Your previous response looked like a ${rejection.tool} tool call, but its arguments did not match the tool schema.`,
    `Validation error: ${rejection.reason}`,
    "Do not answer with that JSON as chat text.",
    rejection.tool === "run_validator"
      ? "If this command is not a strict validator shape but the user still needs command output, retry with run_command when project policy allows it."
      : "",
    "Reply now with one valid tool call JSON object for the next action, or answer in plain text if no tool is needed.",
  ]
    .filter(Boolean)
    .join("\n");
}

function getTextToolCallSources(protocol: ToolProtocol): readonly ToolCallSource[] {
  return protocol === "text-xml" ? ["text-xml"] : protocol === "text-json" ? ["text-json"] : ["text-json", "text-xml"];
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
    case "run_command":
      return result?.tool === "run_command" && !isToolErrorResult(result)
        ? `run_command: ${call.args.command} (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}, ${formatSeconds(result.durationMs)})`
        : `run_command: ${call.args.command}`;
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

  if (typeof usage.costUsd === "number") {
    totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
  }
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
