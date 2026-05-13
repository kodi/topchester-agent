import { executeSlashCommand, parseSlashCommand } from "./commands.js";
import { type ConversationTurn, buildConversationPrompt } from "./conversation.js";
import { agentEvent, choiceAction, type AgentRuntimeEvent } from "./events.js";
import { checkAgentReady } from "./health.js";
import { getChatSystemPrompt } from "./prompts.js";
import { executeToolCall, parseToolCall, type ToolCall, type ToolResult } from "./tools.js";
import { type AppContext } from "../app/context.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";
import { type KnowledgeProgressReporter } from "../knowledge/progress.js";

const MAX_TOOL_CALLS_PER_TURN = 8;

export interface AgentRuntime {
  checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]>;
  checkKnowledgeBase(): AgentRuntimeEvent[];
  submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal
  ): Promise<AgentRuntimeEvent[]>;
  submitSlashCommand(command: string, onProgress?: KnowledgeProgressReporter): Promise<AgentRuntimeEvent[]>;
}

export class TopchesterAgentRuntime implements AgentRuntime {
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

  checkKnowledgeBase(): AgentRuntimeEvent[] {
    return getKnowledgeStatusEvents(getKnowledgeStatus(this.context.workspaceRoot), this.context.devFlags);
  }

  async submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal
  ): Promise<AgentRuntimeEvent[]> {
    const prompt = buildConversationPrompt(conversation, message);
    const events: AgentRuntimeEvent[] = [];
    let nextPrompt = prompt;
    let totalDurationMs = 0;
    let lastModelId = "model";
    let afterTool: ToolCall["tool"] | undefined;

    for (let toolCalls = 0; toolCalls <= MAX_TOOL_CALLS_PER_TURN; toolCalls += 1) {
      const startedAt = Date.now();
      const result = await this.context.modelGateway.generateText({
        purpose: "agent.primary",
        system: getChatSystemPrompt(),
        prompt: nextPrompt,
        abortSignal,
      });
      const durationMs = Date.now() - startedAt;
      const toolCall = parseToolCall(result.text);
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
          text: result.text,
        },
        afterTool ? "model response text after tool" : "model response text"
      );

      if (!toolCall) {
        events.push(
          agentEvent.assistantMessage(
            result.text.trim() || "I got an empty response from the model.",
            formatAgentMessageMeta(result.modelId, totalDurationMs)
          ),
          agentEvent.status("ready")
        );
        return events;
      }

      if (toolCalls === MAX_TOOL_CALLS_PER_TURN) {
        events.push(
          agentEvent.systemMessage(`Stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn.`),
          agentEvent.status("ready")
        );
        return events;
      }

      const toolResult = await executeToolCall(this.context.workspaceRoot, toolCall, {
        logger: this.context.logger,
      });
      events.push(agentEvent.toolCall(toolCall, formatToolCallMessage(toolCall, toolResult)));
      afterTool = toolCall.tool;
      nextPrompt = `${nextPrompt}\n\n${formatToolResultForPrompt(toolResult)}\n\nContinue the user's request using the tool result above. If another tool is needed, reply with only that tool JSON. Otherwise answer the user. Do not guess.`;
    }

    return [
      ...events,
      agentEvent.assistantMessage(
        "I stopped because the tool loop ended unexpectedly.",
        formatAgentMessageMeta(lastModelId, totalDurationMs)
      ),
      agentEvent.status("ready"),
    ];
  }

  async submitSlashCommand(command: string, onProgress?: KnowledgeProgressReporter): Promise<AgentRuntimeEvent[]> {
    const result = await executeSlashCommand(command, {
      workspaceRoot: this.context.workspaceRoot,
      config: this.context.config,
      modelGateway: this.context.modelGateway,
      onProgress,
    });
    const events: AgentRuntimeEvent[] = [agentEvent.systemMessage(result.messages.join("\n"))];

    if (shouldRefreshKnowledgeStatus(command)) {
      events.push(agentEvent.knowledgeStatus(getKnowledgeStatus(this.context.workspaceRoot)));
    }

    events.push(agentEvent.status("ready"));

    return events;
  }
}

function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "reset", "compile", "status"].includes(parsed.args[0] ?? "");
}

export function getKnowledgeStatusEvents(status: KnowledgeStatus, devFlags = new Set<string>()): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [agentEvent.knowledgeStatus(status)];

  if (devFlags.has("disable-kb-check-modal")) {
    return events;
  }

  if (!status.kbExists) {
    events.push(
      agentEvent.choice({
        tone: "warning",
        title: "No KB found",
        body: "Topchester needs a project knowledge base before normal coding can start.",
        actions: [choiceAction("Create KB now", "/kb init"), choiceAction("Exit")],
      })
    );
  } else if (!status.kbIsDirectory) {
    events.push(
      agentEvent.choice({
        tone: "warning",
        title: "KB path is not a folder",
        body: `This path exists but is not a folder:\n${status.kbPath}`,
        actions: [choiceAction("Exit")],
      })
    );
  }

  return events;
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

  return [`Tool result from ${result.tool}${path}${command}:${warning}`, "```", result.content, "```"].join("\n");
}

function formatToolCallMessage(call: ToolCall, result?: ToolResult): string {
  switch (call.tool) {
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
    case "inspect_command":
      return `inspect_command: ${call.args.command}`;
  }
}

function formatEditFileChangeSummary(result: ToolResult | undefined): string {
  if (result?.tool !== "edit_file") {
    return "";
  }

  return ` (changed ${result.editEvent.diffSummary})`;
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
