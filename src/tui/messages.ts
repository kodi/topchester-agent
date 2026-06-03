import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ui } from "../cli/ui.js";
import { type ToolCall } from "../agent/tools.js";
import { type HookEventName } from "../config/index.js";
import { renderUnifiedDiff } from "./diff.js";
import { renderMarkdown } from "./markdown.js";

export type ChatMessageKind =
  | "system"
  | "user"
  | "agent"
  | "thinking"
  | "tool_call"
  | "hook_status"
  | "modal"
  | "subagent";

export interface SystemChatMessage {
  kind: "system";
  text: string;
  modelContext?: boolean;
}

export interface UserChatMessage {
  kind: "user";
  text: string;
  modelContext?: boolean;
}

export interface AgentChatMessage {
  kind: "agent";
  text: string;
  meta?: string;
  modelContext?: boolean;
}

export interface ThinkingChatMessage {
  kind: "thinking";
  text: string;
}

export interface ToolCallChatMessage {
  kind: "tool_call";
  call: ToolCall;
  label: string;
  resultSummary?: string;
  diff?: string;
}

export interface HookStatusChatMessage {
  kind: "hook_status";
  eventName?: HookEventName;
  statusMessage?: string;
  label: string;
}

export interface SubagentChatMessage {
  kind: "subagent";
  status: "running" | "event" | "completed" | "failed";
  sessionId: string;
  title?: string;
  text?: string;
}

export interface ChatModalAction {
  label: string;
  value?: string;
}

export interface ChatModalMessage {
  kind: "modal";
  tone: "info" | "warning";
  title: string;
  body?: string;
  actions: ChatModalAction[];
}

export type ChatMessage =
  | SystemChatMessage
  | UserChatMessage
  | AgentChatMessage
  | ThinkingChatMessage
  | ToolCallChatMessage
  | HookStatusChatMessage
  | SubagentChatMessage
  | ChatModalMessage;

export function systemMessage(text: string): ChatMessage {
  return { kind: "system", text };
}

export function userMessage(text: string): ChatMessage {
  return { kind: "user", text };
}

export function agentMessage(text: string, meta?: string): ChatMessage {
  return { kind: "agent", text, meta };
}

export function thinkingMessage(text: string): ChatMessage {
  return { kind: "thinking", text };
}

export function toolCallMessage(call: ToolCall, label: string, resultSummary?: string, diff?: string): ChatMessage {
  return {
    kind: "tool_call",
    call,
    label,
    ...(resultSummary === undefined ? {} : { resultSummary }),
    ...(diff === undefined ? {} : { diff }),
  };
}

export function hookStatusMessage(label: string, eventName?: HookEventName, statusMessage?: string): ChatMessage {
  return {
    kind: "hook_status",
    label,
    ...(eventName === undefined ? {} : { eventName }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
  };
}

export function subagentMessage(message: Omit<SubagentChatMessage, "kind">): ChatMessage {
  return { kind: "subagent", ...message };
}

export function modalMessage(message: Omit<ChatModalMessage, "kind">): ChatMessage {
  return { kind: "modal", ...message };
}

export interface RenderChatMessageOptions {
  maxModalHeight?: number;
  selectedActionIndex?: number;
  width?: number;
}

const DEFAULT_MODAL_VISIBLE_ACTION_LIMIT = 16;

export function renderChatMessage(message: ChatMessage, options: RenderChatMessageOptions = {}): string[] {
  if (message.kind === "modal") {
    return renderChatModal(message, options.selectedActionIndex, options.maxModalHeight, options.width);
  }

  if (message.kind === "tool_call") {
    return renderToolCallMessage(message, options.width);
  }

  if (message.kind === "hook_status") {
    return renderHookStatusMessage(message);
  }

  if (message.kind === "subagent") {
    return renderSubagentMessage(message);
  }

  if (message.kind === "thinking") {
    return message.text.split("\n").map((line) => ui.muted(line));
  }

  if (message.text.length === 0) {
    return [""];
  }

  const lines =
    message.kind === "agent" && options.width !== undefined
      ? renderMarkdown(message.text, Math.max(1, options.width - getPrefix(message.kind).length))
      : message.text.split("\n");

  if (message.kind === "user") {
    return renderUserMessage(lines);
  }

  if (message.kind === "system") {
    return renderSystemMessage(lines);
  }

  const prefix = getPrefix(message.kind);
  const rendered =
    prefix.length === 0
      ? lines
      : lines.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`);

  if (message.meta) {
    const metaText = `↳ ${message.meta}`;
    rendered.push(` ${ui.muted("─".repeat(metaText.length))}`, ` ${ui.muted(metaText)}`);
  }

  return rendered;
}

function renderUserMessage(lines: string[]): string[] {
  const border = "▌";
  const rendered = lines.map((line) => `${border} ${line}`);

  return [`${border} `, ...rendered, `${border} `];
}

function renderSystemMessage(lines: string[]): string[] {
  const bodyPrefix = "   ";

  return [
    ` ${ui.ok("✦")} ${ui.label("System")}:`,
    ...lines.map((line) => `${bodyPrefix}${formatSystemBodyLine(line)}`),
  ];
}

function formatSystemBodyLine(line: string): string {
  const expandedLine = expandTabs(line);

  return expandedLine
    .replace(/\(changed \+\d+\/-\d+\)$/u, (summary) => ui.muted(summary))
    .replace(/\(created \+\d+\)$/u, (summary) => ui.muted(summary));
}

function renderToolCallMessage(message: ToolCallChatMessage, width: number | undefined): string[] {
  const visibleLabel =
    message.resultSummary && !message.label.includes(message.resultSummary)
      ? `${message.label} ${message.resultSummary}`
      : message.label;

  const label = `   ${ui.muted(expandTabs(visibleLabel))}`;

  if (!message.diff) {
    return [label];
  }

  return [label, ...renderUnifiedDiff(message.diff, { indent: "     ", width })];
}

function renderHookStatusMessage(message: HookStatusChatMessage): string[] {
  return [` ${ui.muted(expandTabs(message.label))}`];
}

function renderSubagentMessage(message: SubagentChatMessage): string[] {
  const label = message.title ?? shortSessionId(message.sessionId);

  switch (message.status) {
    case "running":
      return [`   ${ui.muted(`↳ task: ${label} (running)`)}`];
    case "event":
      return message.text ? [`   ${ui.muted(`↳ task: ${label}: ${message.text}`)}`] : [];
    case "completed":
      return [`   ${ui.muted(`↳ task: ${label} (completed)`)}`, ...(message.text ? [`     ${message.text}`] : [])];
    case "failed":
      return [`   ${ui.warn(`↳ task: ${label} (failed)`)}`, ...(message.text ? [`     ${message.text}`] : [])];
  }
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function expandTabs(line: string): string {
  let column = 0;
  let expanded = "";

  for (const char of line) {
    if (char === "\t") {
      const spaces = 4 - (column % 4);
      expanded += " ".repeat(spaces);
      column += spaces;
      continue;
    }

    expanded += char;
    column += 1;
  }

  return expanded;
}

function getPrefix(kind: UserChatMessage["kind"] | AgentChatMessage["kind"] | SystemChatMessage["kind"]): string {
  switch (kind) {
    case "agent":
      return " ";
    case "user":
      return `${ui.label("You")}: `;
    case "system":
      return `${ui.label("System")}: `;
  }
}

function renderChatModal(
  message: ChatModalMessage,
  selectedActionIndex?: number,
  maxModalHeight?: number,
  width?: number
): string[] {
  const icon = message.tone === "warning" ? "⚠️" : "ℹ️";
  const title = message.tone === "warning" ? ui.warn(message.title) : ui.label(message.title);
  const maxContentWidth = width === undefined ? Number.POSITIVE_INFINITY : Math.max(1, width - 4);
  const bodyLines = message.body ? ["", ...wrapModalBody(message.body, maxContentWidth)] : [];
  const baseContentLineCount = 2 + bodyLines.length;
  const maxScrollableActionRows =
    maxModalHeight === undefined
      ? DEFAULT_MODAL_VISIBLE_ACTION_LIMIT
      : Math.max(1, maxModalHeight - baseContentLineCount - 2);
  const selectedIndex =
    message.actions.length === 0 ? 0 : Math.max(0, Math.min(selectedActionIndex ?? 0, message.actions.length - 1));
  const visibleActions = getVisibleModalActions(message.actions, selectedIndex, maxScrollableActionRows);
  const actionLines = visibleActions.actions.map((action, offset) => {
    const index = visibleActions.startIndex + offset;
    const prefix = selectedIndex === index ? ">" : " ";

    return truncateModalLine(`${prefix} ${index + 1}) ${action.label}`, maxContentWidth);
  });
  const scrollHintLines = [
    ...(visibleActions.startIndex > 0
      ? [truncateModalLine(`  ↑ ${visibleActions.startIndex} more`, maxContentWidth)]
      : []),
    ...actionLines,
    ...(visibleActions.endIndex < message.actions.length
      ? [truncateModalLine(`  ↓ ${message.actions.length - visibleActions.endIndex} more`, maxContentWidth)]
      : []),
  ];
  const contentLines = [truncateModalLine(`${icon}  ${title}:`, maxContentWidth), ...bodyLines, "", ...scrollHintLines];
  const contentWidth = Math.min(
    Math.max(...contentLines.map(stripAnsi).map((line) => line.length), 1),
    maxContentWidth
  );
  const top = `╭${"─".repeat(contentWidth + 2)}╮`;
  const bottom = `╰${"─".repeat(contentWidth + 2)}╯`;

  return [
    top,
    ...contentLines.map((line) => `│ ${line}${" ".repeat(contentWidth - stripAnsi(line).length)} │`),
    bottom,
  ];
}

function wrapModalBody(body: string, maxContentWidth: number): string[] {
  if (!Number.isFinite(maxContentWidth)) {
    return body.split("\n");
  }

  return body.split("\n").flatMap((line) => {
    if (line.length === 0) {
      return [""];
    }

    return wrapTextWithAnsi(line, maxContentWidth).map((wrappedLine) =>
      truncateModalLine(wrappedLine, maxContentWidth)
    );
  });
}

function truncateModalLine(line: string, maxContentWidth: number): string {
  if (!Number.isFinite(maxContentWidth)) {
    return line;
  }

  return truncateToWidth(line, maxContentWidth, "…", true);
}

function getVisibleModalActions(
  actions: ChatModalAction[],
  selectedIndex: number,
  maxRows: number
): { actions: ChatModalAction[]; startIndex: number; endIndex: number } {
  const maxActionRows = Math.max(1, Math.min(DEFAULT_MODAL_VISIBLE_ACTION_LIMIT, maxRows));

  if (actions.length <= maxActionRows) {
    return { actions, startIndex: 0, endIndex: actions.length };
  }

  let actionRowCount = maxActionRows;
  let window = getModalActionWindow(actions.length, selectedIndex, actionRowCount);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hintRows = (window.startIndex > 0 ? 1 : 0) + (window.endIndex < actions.length ? 1 : 0);
    const nextActionRowCount = Math.max(1, Math.min(DEFAULT_MODAL_VISIBLE_ACTION_LIMIT, maxRows - hintRows));

    if (nextActionRowCount === actionRowCount) {
      break;
    }

    actionRowCount = nextActionRowCount;
    window = getModalActionWindow(actions.length, selectedIndex, actionRowCount);
  }

  return {
    actions: actions.slice(window.startIndex, window.endIndex),
    startIndex: window.startIndex,
    endIndex: window.endIndex,
  };
}

function getModalActionWindow(
  actionCount: number,
  selectedIndex: number,
  actionRowCount: number
): { startIndex: number; endIndex: number } {
  const boundedActionRowCount = Math.max(1, Math.min(actionCount, actionRowCount));
  const maxStartIndex = actionCount - boundedActionRowCount;
  const centeredStartIndex = selectedIndex - Math.floor(boundedActionRowCount / 2);
  const startIndex = Math.max(0, Math.min(centeredStartIndex, maxStartIndex));

  return { startIndex, endIndex: startIndex + boundedActionRowCount };
}

function stripAnsi(text: string): string {
  let plain = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m") {
        index += 1;
      }
      continue;
    }

    plain += text[index];
  }

  return plain;
}
