import { executeSlashCommand } from "./commands.js";
import { type ConversationTurn, buildConversationPrompt } from "./conversation.js";
import { agentEvent, choiceAction, type AgentRuntimeEvent } from "./events.js";
import { checkAgentReady } from "./health.js";
import { getChatSystemPrompt } from "./prompts.js";
import { executeToolCall, parseToolCall, type ToolCall, type ToolResult } from "./tools.js";
import { type AppContext } from "../app/context.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";

export interface AgentRuntime {
  checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]>;
  checkKnowledgeBase(): AgentRuntimeEvent[];
  submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal
  ): Promise<AgentRuntimeEvent[]>;
  submitSlashCommand(command: string): Promise<AgentRuntimeEvent[]>;
}

export class TopchesterAgentRuntime implements AgentRuntime {
  constructor(private readonly context: AppContext) {}

  async checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]> {
    const result = await checkAgentReady(this.context.modelGateway, abortSignal);

    if (result === "ready") {
      return [agentEvent.assistantMessage("ready"), agentEvent.status("ready")];
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
    const startedAt = Date.now();
    const result = await this.context.modelGateway.generateText({
      purpose: "agent.primary",
      system: getChatSystemPrompt(),
      prompt,
      abortSignal,
    });
    const durationMs = Date.now() - startedAt;
    const meta = formatAgentMessageMeta(result.modelId, durationMs);
    const toolCall = parseToolCall(result.text);

    this.context.logger.debug(
      {
        event: "model_response",
        purpose: "agent.primary",
        modelId: result.modelId,
        durationMs,
        textLength: result.text.length,
        hasToolCall: Boolean(toolCall),
      },
      "model response"
    );
    this.context.logger.trace(
      {
        event: "model_response_text",
        purpose: "agent.primary",
        modelId: result.modelId,
        text: result.text,
      },
      "model response text"
    );

    if (toolCall) {
      const toolResult = await executeToolCall(this.context.workspaceRoot, toolCall, {
        logger: this.context.logger,
      });
      const finalStartedAt = Date.now();
      const finalResult = await this.context.modelGateway.generateText({
        purpose: "agent.primary",
        system: getChatSystemPrompt(),
        prompt: `${prompt}\n\n${formatToolResultForPrompt(toolResult)}\n\nAnswer the user's request using the tool result above. Do not guess.`,
        abortSignal,
      });
      const finalModelDurationMs = Date.now() - finalStartedAt;
      const finalDurationMs = durationMs + finalModelDurationMs;
      const finalMeta = formatAgentMessageMeta(finalResult.modelId, finalDurationMs);

      this.context.logger.debug(
        {
          event: "model_response",
          purpose: "agent.primary",
          modelId: finalResult.modelId,
          durationMs: finalModelDurationMs,
          totalDurationMs: finalDurationMs,
          textLength: finalResult.text.length,
          afterTool: toolCall.tool,
        },
        "model response after tool"
      );
      this.context.logger.trace(
        {
          event: "model_response_text",
          purpose: "agent.primary",
          modelId: finalResult.modelId,
          afterTool: toolCall.tool,
          text: finalResult.text,
        },
        "model response text after tool"
      );

      return [
        agentEvent.toolCall(toolCall, formatToolCallMessage(toolCall)),
        agentEvent.assistantMessage(finalResult.text.trim() || "I got an empty response from the model.", finalMeta),
        agentEvent.status("ready"),
      ];
    }

    return [
      agentEvent.assistantMessage(result.text.trim() || "I got an empty response from the model.", meta),
      agentEvent.status("ready"),
    ];
  }

  async submitSlashCommand(command: string): Promise<AgentRuntimeEvent[]> {
    const result = await executeSlashCommand(command, {
      workspaceRoot: this.context.workspaceRoot,
      modelGateway: this.context.modelGateway,
    });

    return [agentEvent.systemMessage(result.messages.join("\n")), agentEvent.status("ready")];
  }
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

  return [`Tool result from ${result.tool}${path}${command}:${warning}`, "```", result.content, "```"].join("\n");
}

function formatToolCallMessage(call: ToolCall): string {
  switch (call.tool) {
    case "read_file":
      return `Tool read_file: ${call.args.path}`;
    case "grep":
      return `Tool grep: ${call.args.pattern} in ${call.args.path ?? "."}`;
    case "find_file":
      return `Tool find_file: ${call.args.query} in ${call.args.path}`;
  }
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
