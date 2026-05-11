import { type AgentRuntimeEvent } from "../agent/events.js";
import { getKnowledgeStatusEvents } from "../agent/runtime.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { agentMessage, modalMessage, systemMessage, type ChatMessage } from "./messages.js";
import { formatPathStatus } from "./status.js";

export function getKnowledgeStatusMessages(status: KnowledgeStatus, devFlags = new Set<string>()): ChatMessage[] {
  return renderRuntimeEvents(getKnowledgeStatusEvents(status, devFlags));
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
          `KB status: ${formatPathStatus(event.status.kbPath, event.status.kbExists, event.status.kbIsDirectory)} (${event.status.kbPathSource})`
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
