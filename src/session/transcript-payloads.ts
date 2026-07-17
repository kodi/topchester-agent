import { formatStartupTranscriptText, type PersistedTranscriptEntry, type TranscriptEntry } from "../chat/index.js";
import { type SessionEventPayload } from "./events.js";

export function transcriptEntryToSessionPayload(entry: TranscriptEntry): SessionEventPayload | undefined {
  if (entry.persistence === "display") {
    return undefined;
  }

  return persistedTranscriptEntryToSessionPayload(entry);
}

export function slashCommandToSessionPayload(command: string): SessionEventPayload {
  return {
    kind: "message",
    role: "user",
    text: command,
    meta: { source: "slash_command", visibleOnly: true },
  };
}

function persistedTranscriptEntryToSessionPayload(entry: PersistedTranscriptEntry): SessionEventPayload {
  switch (entry.kind) {
    case "system":
    case "user":
      return {
        kind: "message",
        role: entry.kind,
        text: entry.text,
      };
    case "assistant":
      return {
        kind: "message",
        role: "assistant",
        text: entry.text,
        ...(entry.meta === undefined ? {} : { meta: entry.meta }),
      };
    case "startup":
      return {
        kind: "message",
        role: "system",
        text: formatStartupTranscriptText(entry),
        meta: { source: "startup", entry },
      };
    case "tool_call":
      return {
        kind: "tool_call",
        label: entry.label,
        call: entry.call as unknown as Record<string, unknown>,
        ...(entry.diff === undefined ? {} : { diff: entry.diff }),
      };
    case "hook_status":
      return {
        kind: "hook_status",
        eventName: entry.eventName,
        statusMessage: entry.statusMessage,
        label: entry.label,
      };
    case "choice":
      return {
        kind: "choice",
        tone: entry.tone,
        title: entry.title,
        ...(entry.body === undefined ? {} : { body: entry.body }),
        actions: entry.actions,
      };
    case "permission_auto_approved":
      return {
        kind: "permission_auto_approved",
        permissionMode: entry.permissionMode,
        approvalMode: entry.approvalMode,
        toolName: entry.toolName,
        command: entry.command,
        workdir: entry.workdir,
        reason: entry.reason,
        label: entry.label,
        ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      };
    case "subagent":
      return subagentTranscriptEntryToSessionPayload(entry);
  }
}

function subagentTranscriptEntryToSessionPayload(
  entry: Extract<PersistedTranscriptEntry, { kind: "subagent" }>
): SessionEventPayload {
  const reference = {
    sessionId: entry.sessionId,
    parentSessionId: entry.parentSessionId,
    parentToolCallId: entry.parentToolCallId,
  };

  switch (entry.status) {
    case "running":
      return {
        kind: "subagent_started",
        ...reference,
        ...(entry.agentProfileId === undefined ? {} : { agentProfileId: entry.agentProfileId }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
      };
    case "event":
      return {
        kind: "subagent_event",
        ...reference,
        event: (entry.event ?? {}) as unknown as Record<string, unknown>,
      };
    case "completed":
      return {
        kind: "subagent_completed",
        ...reference,
        ...(entry.text === undefined ? {} : { result: entry.text }),
      };
    case "failed":
      return {
        kind: "subagent_failed",
        ...reference,
        error: entry.text ?? "Unknown subagent failure",
      };
  }
}
