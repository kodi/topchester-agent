import { reloadAppBaseConfig, type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { addProjectBashAllowExactRule } from "../config/index.js";
import { type ModelReasoningEvent, type ModelReasoningSink } from "../model/index.js";
import { BusyIndicator, ReasoningTailBuffer } from "./busy.js";
import { type ChatLayout } from "./layout.js";
import { thinkingMessage } from "./messages.js";
import { getModelSetupHint } from "./status.js";

export function isStreamReasoningEnabledByEnv(): boolean {
  const value = process.env.TOPCHESTER_STREAM_REASONING?.trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function createBusyReasoningSink(busy: BusyIndicator): {
  sink: ModelReasoningSink;
  commit(app: ChatLayout): void;
} {
  const buffer = new ReasoningTailBuffer();
  let committed = false;

  return {
    commit(app: ChatLayout) {
      if (committed || !buffer.hasText) {
        return;
      }

      app.addMessage(thinkingMessage(buffer.value));
      committed = true;
    },
    async sink(event: ModelReasoningEvent) {
      if (event.type === "clear") {
        buffer.clear();
        committed = false;
        busy.clearActivity();
        return;
      }

      const text = event.type === "summary" ? buffer.replace(event.text ?? "") : buffer.append(event.text ?? "");

      if (!text) {
        return;
      }

      busy.setActivity(
        text
          .split("\n")
          .map((line) => ui.muted(line))
          .join("\n")
      );
    },
  };
}

export function formatAgentCheckSetupHint(message: string, context: AppContext): string | undefined {
  if (!/No (model|provider) configured/u.test(message)) {
    return undefined;
  }

  return getModelSetupHint(context);
}

export async function persistBashApproval(context: AppContext, command: string): Promise<void> {
  await addProjectBashAllowExactRule(context.workspaceRoot, command);
  reloadAppBaseConfig(context);
}

export function printExitBanner(sessionId: string, durationMs: number): void {
  console.log("");
  console.log(`${ui.heading("session ended")} ${ui.label(`after ${formatDuration(durationMs)}`)}`);
  console.log(`${ui.label("To resume this session, run:")} ${ui.ok(`topchester --resume ${sessionId}`)}`);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  }

  return parts.join(" ");
}

export function getSlashCommandActivities(command: string): string[] {
  if (command.startsWith("/kb sync")) {
    const isFullSync = command.split(/\s+/).includes("--full");
    return [
      "Checking project knowledge folders...",
      "Reading .gitignore files...",
      isFullSync ? "Listing project files..." : "Checking KB file status...",
      "Queueing L1 work...",
    ];
  }

  if (command.startsWith("/kb reset")) {
    return ["Checking project knowledge paths...", "Removing knowledge folder...", "Removing local cache folder..."];
  }

  return ["Running command...", "Preparing project knowledge folders...", "Writing project knowledge folders..."];
}

export function isNewSessionCommand(command: string): boolean {
  return command.trim() === "/new";
}

export function isForkSessionCommand(command: string): boolean {
  return command.trim() === "/fork";
}

export function isRestoreSessionCommand(command: string): boolean {
  return command.trim() === "/restore";
}

export function isConnectCommand(command: string): boolean {
  const name = getSlashCommandName(command);

  return name === "connect" || name === "provider" || name === "providers";
}

export function isModelCommand(command: string): boolean {
  const name = getSlashCommandName(command);

  return name === "model" || name === "models";
}

export function isReasoningEffortCommand(command: string): boolean {
  const name = getSlashCommandName(command);

  return name === "effort" || name === "reasoning";
}

function getSlashCommandName(command: string): string | undefined {
  return command.trim().slice(1).split(/\s+/u).filter(Boolean)[0]?.toLowerCase();
}

export function getSlashCommandArgs(command: string): string[] {
  return command.trim().slice(1).split(/\s+/u).filter(Boolean).slice(1);
}
