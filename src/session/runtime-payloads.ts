import { type AgentRuntimeEvent } from "../agent/events.js";
import { type SessionEventPayload } from "./events.js";

export function runtimeEventToSessionPayload(event: AgentRuntimeEvent): SessionEventPayload | undefined {
  switch (event.type) {
    case "message":
      return {
        kind: "message",
        role: event.role,
        text: event.text,
        ...(event.meta === undefined ? {} : { meta: event.meta }),
      };
    case "permission_auto_approved":
      return {
        kind: "permission_auto_approved",
        permissionMode: event.permissionMode,
        approvalMode: event.approvalMode,
        toolName: event.toolName,
        command: event.command,
        workdir: event.workdir,
        reason: event.reason,
        label: event.label,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        label: event.label,
        call: event.call as unknown as Record<string, unknown>,
        ...(event.diff === undefined ? {} : { diff: event.diff }),
      };
    case "hook_status":
      return {
        kind: "hook_status",
        eventName: event.eventName,
        statusMessage: event.statusMessage,
        label: event.label,
      };
    case "task_plan":
      return {
        kind: "task_plan",
        items: event.plan.items,
        updatedAt: event.plan.updatedAt,
      };
    case "instruction_context":
      return {
        kind: "instruction_context",
        sources: event.sources,
      };
    case "knowledge_status":
      return undefined;
    case "choice":
      return {
        kind: "choice",
        tone: event.tone,
        title: event.title,
        ...(event.body === undefined ? {} : { body: event.body }),
        actions: event.actions,
      };
    case "subagent_started":
      return {
        kind: "subagent_started",
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        parentToolCallId: event.parentToolCallId,
        ...(event.agentProfileId === undefined ? {} : { agentProfileId: event.agentProfileId }),
        ...(event.title === undefined ? {} : { title: event.title }),
      };
    case "subagent_event":
      return {
        kind: "subagent_event",
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        parentToolCallId: event.parentToolCallId,
        event: event.event as unknown as Record<string, unknown>,
      };
    case "subagent_completed":
      return {
        kind: "subagent_completed",
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        parentToolCallId: event.parentToolCallId,
        ...(event.result === undefined ? {} : { result: event.result }),
      };
    case "subagent_failed":
      return {
        kind: "subagent_failed",
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        parentToolCallId: event.parentToolCallId,
        error: event.error,
      };
    case "status":
      return {
        kind: "status",
        status: event.status,
      };
  }
}
