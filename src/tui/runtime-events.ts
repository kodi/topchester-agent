import { type AgentRuntimeEvent } from "../agent/events.js";
import { getKnowledgeStatusEvents } from "../agent/runtime/index.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import {
  agentMessage,
  hookStatusMessage,
  modalMessage,
  subagentMessage,
  systemMessage,
  toolCallMessage,
  type ChatMessage,
} from "./messages.js";
import { formatKnowledgePathStatus } from "./status.js";

export function getKnowledgeStatusMessages(status: KnowledgeStatus): ChatMessage[] {
  return renderRuntimeEvents(getKnowledgeStatusEvents(status));
}

export function renderRuntimeEvents(events: AgentRuntimeEvent[]): ChatMessage[] {
  return events.flatMap(renderRuntimeEvent);
}

export function renderRuntimeEvent(event: AgentRuntimeEvent): ChatMessage[] {
  switch (event.type) {
    case "message":
      return [event.role === "assistant" ? agentMessage(event.text, event.meta) : systemMessage(event.text)];
    case "tool_call":
      return [toolCallMessage(event.call, event.label, undefined, event.diff)];
    case "hook_status":
      return [hookStatusMessage(event.label, event.eventName, event.statusMessage)];
    case "knowledge_status":
      return [
        systemMessage(
          [`KB status: ${formatKnowledgePathStatus(event.status)}${formatKbPathSource(event.status)}`, event.guidance]
            .filter(Boolean)
            .join("\n")
        ),
      ];
    case "choice":
      return [
        modalMessage({
          tone: event.tone,
          title: event.title,
          body: event.body,
          actions: event.actions,
        }),
      ];
    case "task_plan":
      return [];
    case "instruction_context":
      return [];
    case "subagent_started":
      return [
        subagentMessage({
          status: "running",
          sessionId: event.sessionId,
          title: event.title,
        }),
      ];
    case "subagent_event":
      return formatForwardedSubagentEvent(event.sessionId, event.event);
    case "subagent_completed":
      return [
        subagentMessage({
          status: "completed",
          sessionId: event.sessionId,
          text: event.result,
        }),
      ];
    case "subagent_failed":
      return [
        subagentMessage({
          status: "failed",
          sessionId: event.sessionId,
          text: event.error,
        }),
      ];
    case "status":
      return [];
  }
}

function formatForwardedSubagentEvent(sessionId: string, event: AgentRuntimeEvent): ChatMessage[] {
  if (event.type === "message" && event.role === "assistant") {
    return [
      subagentMessage({
        status: "event",
        sessionId,
        text: event.text,
      }),
    ];
  }

  if (event.type === "tool_call") {
    return [
      subagentMessage({
        status: "event",
        sessionId,
        text: event.label,
      }),
    ];
  }

  if (event.type === "hook_status") {
    return [
      subagentMessage({
        status: "event",
        sessionId,
        text: event.label,
      }),
    ];
  }

  return [];
}

function formatKbPathSource(status: KnowledgeStatus): string {
  return status.kbPathSource === "env" ? " (custom)" : "";
}
