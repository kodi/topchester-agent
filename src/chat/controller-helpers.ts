import { reloadAppBaseConfig, type AppContext } from "../app/context.js";
import { addProjectBashAllowExactRule, getConfiguredReasoningEffort, type ReasoningEffort } from "../config/index.js";
import { type ModelPurpose } from "../model/index.js";
import { getModelSetupHint } from "./startup.js";

export function formatPlainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "Unknown error";
}

export function getModelLabel(context: AppContext): string {
  const purpose = context.config.models?.defaultPurpose ?? "agent.primary";
  const model =
    context.config.models?.assignments?.[purpose as ModelPurpose] ?? context.config.models?.assignments?.fallback;

  if (!model) {
    return "not set";
  }

  const provider = model.provider ?? context.config.providers?.default;
  const effort = getConfiguredReasoningEffort(context.config, typeof provider === "string" ? provider : undefined);
  const effortLabel = effort ? ` · effort ${effort}` : "";

  return typeof provider === "string" ? `${model.name} [${provider}]${effortLabel}` : `${model.name}${effortLabel}`;
}

export function isStreamReasoningEnabledByEnv(): boolean {
  const value = process.env.TOPCHESTER_STREAM_REASONING?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function formatAgentCheckSetupHint(message: string, context: AppContext): string | undefined {
  return /No (model|provider) configured/u.test(message) ? getModelSetupHint(context) : undefined;
}

export async function persistBashApproval(context: AppContext, command: string): Promise<void> {
  await addProjectBashAllowExactRule(context.workspaceRoot, command);
  reloadAppBaseConfig(context);
}

export function getSlashCommandActivities(command: string): string[] {
  if (command.startsWith("/kb sync")) {
    const isFullSync = command.split(/\s+/u).includes("--full");
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

export function getSlashCommandArgs(command: string): string[] {
  return command.trim().slice(1).split(/\s+/u).filter(Boolean).slice(1);
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

export function isKbModelCommand(command: string): boolean {
  return getSlashCommandName(command) === "kb-model";
}

export function isReasoningEffortCommand(command: string): boolean {
  const name = getSlashCommandName(command);
  return name === "effort" || name === "reasoning";
}

export function parseQueueCommandPrompt(command: string): string | undefined {
  const match = /^\/(?:queue|q)(?:\s+([\s\S]*))?$/u.exec(command.trim());
  return match ? (match[1] ?? "") : undefined;
}

export function parseSteerCommandPrompt(command: string): string | undefined {
  const match = /^\/steer(?:\s+([\s\S]*))?$/u.exec(command.trim());
  return match ? (match[1] ?? "") : undefined;
}

export function isReasoningEffort(
  value: string | undefined,
  efforts: readonly ReasoningEffort[]
): value is ReasoningEffort {
  return efforts.includes(value as ReasoningEffort);
}

function getSlashCommandName(command: string): string | undefined {
  return command.trim().slice(1).split(/\s+/u).filter(Boolean)[0]?.toLowerCase();
}
