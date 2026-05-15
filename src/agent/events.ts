import { type KnowledgeStatus } from "../knowledge/status.js";
import { type TaskPlanState } from "./task-plan.js";
import { type ToolCall } from "./tools.js";

export type AgentRuntimeEvent =
  | AgentStatusEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentTaskPlanEvent
  | AgentKnowledgeStatusEvent
  | AgentChoiceEvent
  | AgentSubagentStartedEvent
  | AgentSubagentEvent
  | AgentSubagentCompletedEvent
  | AgentSubagentFailedEvent;

export interface AgentStatusEvent {
  type: "status";
  status: string;
}

export interface AgentMessageEvent {
  type: "message";
  role: "system" | "assistant";
  text: string;
  meta?: string;
}

export interface AgentToolCallEvent {
  type: "tool_call";
  call: ToolCall;
  label: string;
}

export interface AgentTaskPlanEvent {
  type: "task_plan";
  plan: TaskPlanState;
}

export interface AgentKnowledgeStatusEvent {
  type: "knowledge_status";
  status: KnowledgeStatus;
  guidance?: string;
}

export interface AgentChoiceEvent {
  type: "choice";
  tone: "info" | "warning";
  title: string;
  body?: string;
  actions: AgentChoiceAction[];
}

export interface AgentChoiceAction {
  label: string;
  value?: string;
}

export interface AgentSubagentStartedEvent {
  type: "subagent_started";
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  agentProfileId?: string;
  title?: string;
}

export interface AgentSubagentEvent {
  type: "subagent_event";
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  event: AgentRuntimeEvent;
}

export interface AgentSubagentCompletedEvent {
  type: "subagent_completed";
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  result?: string;
}

export interface AgentSubagentFailedEvent {
  type: "subagent_failed";
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  error: string;
}

export interface AgentChoiceOptions {
  tone: AgentChoiceEvent["tone"];
  title: string;
  body?: string;
  actions: AgentChoiceAction[];
}

export interface AgentSubagentEventBaseOptions {
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
}

export interface AgentSubagentStartedOptions extends AgentSubagentEventBaseOptions {
  agentProfileId?: string;
  title?: string;
}

export interface AgentSubagentCompletedOptions extends AgentSubagentEventBaseOptions {
  result?: string;
}

export interface AgentSubagentFailedOptions extends AgentSubagentEventBaseOptions {
  error: string;
}

export const ABORT_CHOICE_VALUE = "__topchester_abort__";

export const agentEvent = {
  status(status: string): AgentStatusEvent {
    return { type: "status", status };
  },

  systemMessage(text: string): AgentMessageEvent {
    return { type: "message", role: "system", text };
  },

  assistantMessage(text: string, meta?: string): AgentMessageEvent {
    return meta === undefined
      ? { type: "message", role: "assistant", text }
      : { type: "message", role: "assistant", text, meta };
  },

  toolCall(call: ToolCall, label: string): AgentToolCallEvent {
    return { type: "tool_call", call, label };
  },

  taskPlan(plan: TaskPlanState): AgentTaskPlanEvent {
    return { type: "task_plan", plan };
  },

  knowledgeStatus(status: KnowledgeStatus, guidance?: string): AgentKnowledgeStatusEvent {
    return guidance === undefined
      ? { type: "knowledge_status", status }
      : { type: "knowledge_status", status, guidance };
  },

  choice(options: AgentChoiceOptions): AgentChoiceEvent {
    return { type: "choice", ...options };
  },

  subagentStarted(options: AgentSubagentStartedOptions): AgentSubagentStartedEvent {
    return { type: "subagent_started", ...options };
  },

  subagentEvent(options: AgentSubagentEventBaseOptions, event: AgentRuntimeEvent): AgentSubagentEvent {
    return { type: "subagent_event", ...options, event };
  },

  subagentCompleted(options: AgentSubagentCompletedOptions): AgentSubagentCompletedEvent {
    return { type: "subagent_completed", ...options };
  },

  subagentFailed(options: AgentSubagentFailedOptions): AgentSubagentFailedEvent {
    return { type: "subagent_failed", ...options };
  },
} as const;

export function choiceAction(label: string, value?: string): AgentChoiceAction {
  return value === undefined ? { label } : { label, value };
}

export function isSubagentRuntimeEvent(
  event: AgentRuntimeEvent
): event is AgentSubagentStartedEvent | AgentSubagentEvent | AgentSubagentCompletedEvent | AgentSubagentFailedEvent {
  return event.type.startsWith("subagent_");
}
