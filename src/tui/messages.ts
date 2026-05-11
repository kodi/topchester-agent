import { ui } from "../cli/ui.js";

export type ChatMessageKind = "system" | "user" | "agent";

export interface ChatMessage {
  kind: ChatMessageKind;
  text: string;
}

export function systemMessage(text: string): ChatMessage {
  return { kind: "system", text };
}

export function userMessage(text: string): ChatMessage {
  return { kind: "user", text };
}

export function agentMessage(text: string): ChatMessage {
  return { kind: "agent", text };
}

export function renderChatMessage(message: ChatMessage): string[] {
  if (message.text.length === 0) {
    return [""];
  }

  const lines = message.text.split("\n");
  const prefix = getPrefix(message.kind);

  return lines.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`);
}

function getPrefix(kind: ChatMessageKind): string {
  switch (kind) {
    case "agent":
      return `${ui.ok("Agent")}: `;
    case "user":
      return `${ui.label("You")}: `;
    case "system":
      return `${ui.label("System")}: `;
  }
}
