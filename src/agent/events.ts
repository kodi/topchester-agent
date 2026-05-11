import { type KnowledgeStatus } from "../knowledge/status.js";
import { type ToolCall } from "./tools.js";

export type AgentRuntimeEvent =
  | AgentStatusEvent
  | AgentMessageEvent
  | AgentToolCallEvent
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

export interface AgentKnowledgeStatusEvent {
  type: "knowledge_status";
  status: KnowledgeStatus;
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

  knowledgeStatus(status: KnowledgeStatus): AgentKnowledgeStatusEvent {
    return { type: "knowledge_status", status };
  },

  choice(options: AgentChoiceOptions): AgentChoiceEvent {
    return { type: "choice", ...options };
  },
} as const;

export function choiceAction(label: string, value?: string): AgentChoiceAction {
  return value === undefined ? { label } : { label, value };
}
