import { ui } from "../cli/ui.js";

export type ChatMessageKind = "system" | "user" | "agent" | "modal";

interface TextChatMessage {
  kind: Exclude<ChatMessageKind, "modal">;
  text: string;
  meta?: string;
  modelContext?: boolean;
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

export type ChatMessage = TextChatMessage | ChatModalMessage;

export function systemMessage(text: string): ChatMessage {
  return { kind: "system", text };
}

export function userMessage(text: string): ChatMessage {
  return { kind: "user", text };
}

export function agentMessage(text: string, meta?: string): ChatMessage {
  return { kind: "agent", text, meta };
}

export function modalMessage(message: Omit<ChatModalMessage, "kind">): ChatMessage {
  return { kind: "modal", ...message };
}

export interface RenderChatMessageOptions {
  selectedActionIndex?: number;
}

export function renderChatMessage(message: ChatMessage, options: RenderChatMessageOptions = {}): string[] {
  if (message.kind === "modal") {
    return renderChatModal(message, options.selectedActionIndex);
  }

  if (message.text.length === 0) {
    return [""];
  }

  const lines = message.text.split("\n");

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
    rendered.push(` ${ui.label(message.meta)}`);
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
  return line.replace(/\(changed \+\d+\/-\d+\)$/u, (summary) => ui.muted(summary));
}

function getPrefix(kind: TextChatMessage["kind"]): string {
  switch (kind) {
    case "agent":
      return " ";
    case "user":
      return `${ui.label("You")}: `;
    case "system":
      return `${ui.label("System")}: `;
  }
}

function renderChatModal(message: ChatModalMessage, selectedActionIndex?: number): string[] {
  const icon = message.tone === "warning" ? "⚠️" : "ℹ️";
  const title = message.tone === "warning" ? ui.warn(message.title) : ui.label(message.title);
  const bodyLines = message.body ? ["", ...message.body.split("\n")] : [];
  const actionLines = message.actions.map((action, index) => {
    const prefix = selectedActionIndex === index ? ">" : " ";

    return `${prefix} ${index + 1}) ${action.label}`;
  });
  const contentLines = [`${icon}  ${title}:`, ...bodyLines, "", ...actionLines];
  const contentWidth = Math.max(...contentLines.map(stripAnsi).map((line) => line.length), 1);
  const top = `╭${"─".repeat(contentWidth + 2)}╮`;
  const bottom = `╰${"─".repeat(contentWidth + 2)}╯`;

  return [
    top,
    ...contentLines.map((line) => `│ ${line}${" ".repeat(contentWidth - stripAnsi(line).length)} │`),
    bottom,
  ];
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
