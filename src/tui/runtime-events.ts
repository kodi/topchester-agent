import { type AgentRuntimeEvent } from "../agent/events.js";
import { getKnowledgeStatusEvents } from "../agent/runtime.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { agentMessage, modalMessage, systemMessage, type ChatMessage } from "./messages.js";
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
      return [systemMessage(event.label)];
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
    case "status":
      return [];
  }
}

function formatKbPathSource(status: KnowledgeStatus): string {
  return status.kbPathSource === "env" ? " (custom)" : "";
}
