import { type SessionEventPayload } from "../session/events.js";
import { type SessionHandle } from "../session/store.js";
import { formatPlainError } from "./errors.js";
import { type ChatMessage, systemMessage } from "./messages.js";

export async function persistMessagesWithWarning(
  session: SessionHandle,
  messages: ChatMessage[],
  warningTarget: ChatMessage[] = messages
): Promise<void> {
  for (const message of messages) {
    const payload = chatMessageToSessionPayload(message);
    if (!payload) {
      continue;
    }

    try {
      await session.append(payload);
    } catch (error) {
      warningTarget.push(systemMessage(`Session save failed: ${formatPlainError(error)}`));
      return;
    }
  }
}

export function chatMessageToSessionPayload(message: ChatMessage): SessionEventPayload | undefined {
  if (message.kind === "system" || message.kind === "user") {
    return {
      kind: "message",
      role: message.kind,
      text: message.text,
    };
  }

  if (message.kind === "agent") {
    return {
      kind: "message",
      role: "assistant",
      text: message.text,
      ...(message.meta === undefined ? {} : { meta: message.meta }),
    };
  }

  if (message.kind === "thinking") {
    return undefined;
  }

  if (message.kind === "subagent") {
    return undefined;
  }

  if (message.kind === "modal") {
    return {
      kind: "choice",
      tone: message.tone,
      title: message.title,
      ...(message.body === undefined ? {} : { body: message.body }),
      actions: message.actions,
    };
  }

  if (message.kind === "tool_call") {
    return {
      kind: "tool_call",
      label: message.label,
      call: message.call as unknown as Record<string, unknown>,
    };
  }

  return undefined;
}

export function slashCommandToSessionPayload(command: string): SessionEventPayload {
  return {
    kind: "message",
    role: "user",
    text: command,
    meta: { source: "slash_command", visibleOnly: true },
  };
}
