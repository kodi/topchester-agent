import { type AgentRuntimeEvent } from "../agent/events.js";
import {
  assistantTranscriptEntry,
  systemTranscriptEntry,
  type PersistedSubagentTranscriptEntry,
  type TranscriptEntry,
} from "./transcript.js";

export function runtimeEventsToTranscriptEntries(events: readonly AgentRuntimeEvent[]): TranscriptEntry[] {
  return events.flatMap(runtimeEventToTranscriptEntries);
}

export function runtimeEventToTranscriptEntries(event: AgentRuntimeEvent): TranscriptEntry[] {
  switch (event.type) {
    case "message":
      return [
        event.role === "assistant"
          ? assistantTranscriptEntry(event.text, { meta: event.meta })
          : systemTranscriptEntry(event.text),
      ];
    case "permission_auto_approved":
      return [
        {
          kind: "permission_auto_approved",
          persistence: "session",
          permissionMode: event.permissionMode,
          approvalMode: event.approvalMode,
          toolName: event.toolName,
          command: event.command,
          workdir: event.workdir,
          reason: event.reason,
          label: event.label,
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        },
      ];
    case "tool_call":
      return [
        {
          kind: "tool_call",
          persistence: "session",
          call: event.call,
          label: event.label,
          ...(event.diff === undefined ? {} : { diff: event.diff }),
        },
      ];
    case "hook_status":
      return [
        {
          kind: "hook_status",
          persistence: "session",
          eventName: event.eventName,
          statusMessage: event.statusMessage,
          label: event.label,
        },
      ];
    case "knowledge_status":
      return [
        {
          kind: "knowledge_status",
          persistence: "display",
          status: event.status,
          ...(event.guidance === undefined ? {} : { guidance: event.guidance }),
        },
      ];
    case "choice":
      return [
        {
          kind: "choice",
          persistence: "session",
          tone: event.tone,
          title: event.title,
          ...(event.body === undefined ? {} : { body: event.body }),
          actions: event.actions,
        },
      ];
    case "subagent_started":
      return [subagentEntry(event, "running")];
    case "subagent_event": {
      const text = formatForwardedSubagentEvent(event.event);
      return text === undefined ? [] : [subagentEntry(event, "event", { text, event: event.event })];
    }
    case "subagent_completed":
      return [subagentEntry(event, "completed", { text: event.result })];
    case "subagent_failed":
      return [subagentEntry(event, "failed", { text: event.error })];
    case "task_plan":
    case "instruction_context":
    case "status":
      return [];
  }
}

function subagentEntry(
  event: Extract<AgentRuntimeEvent, { type: `subagent_${string}` }>,
  status: PersistedSubagentTranscriptEntry["status"],
  options: Pick<PersistedSubagentTranscriptEntry, "text" | "event"> = {}
): PersistedSubagentTranscriptEntry {
  return {
    kind: "subagent",
    persistence: "session",
    status,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    parentToolCallId: event.parentToolCallId,
    ...("agentProfileId" in event && event.agentProfileId !== undefined
      ? { agentProfileId: event.agentProfileId }
      : {}),
    ...(event.type === "subagent_started" && event.title !== undefined ? { title: event.title } : {}),
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.event === undefined ? {} : { event: options.event }),
  };
}

function formatForwardedSubagentEvent(event: AgentRuntimeEvent): string | undefined {
  if (event.type === "tool_call" || event.type === "hook_status") {
    return event.label;
  }

  return undefined;
}
