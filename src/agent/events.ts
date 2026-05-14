import { type KnowledgeStatus } from "../knowledge/status.js";
import { type TaskPlanState } from "./task-plan.js";
import { type ToolCall } from "./tools.js";

export type AgentRuntimeEvent =
  | AgentStatusEvent
  | AgentMessageEvent
  | AgentToolCallEvent
  | AgentTaskPlanEvent
  | AgentKnowledgeStatusEvent
  | AgentChoiceEvent;

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

export interface AgentChoiceOptions {
  tone: AgentChoiceEvent["tone"];
  title: string;
  body?: string;
  actions: AgentChoiceAction[];
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
} as const;

export function choiceAction(label: string, value?: string): AgentChoiceAction {
  return value === undefined ? { label } : { label, value };
}
