import { formatKnowledgeInitResult, initializeKnowledgeBase } from "../knowledge/init.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";

export interface SlashCommandContext {
  workspaceRoot: string;
}

export interface SlashCommandResult {
  messages: string[];
}

export interface SlashCommand {
  name: string;
  description: string;
  execute(args: string[], context: SlashCommandContext): SlashCommandResult | Promise<SlashCommandResult>;
}

export interface SlashCommandSuggestion {
  value: string;
  description: string;
}

export interface ParsedSlashCommand {
  name: string;
  args: string[];
}

export const slashCommandSuggestions: SlashCommandSuggestion[] = [
  {
    value: "/kb status",
    description: "show project knowledge base status",
  },
  {
    value: "/kb init",
    description: "start project knowledge base setup",
  },
];

export const slashCommands: SlashCommand[] = [
  {
    name: "kb",
    description: "knowledge base commands",
    execute: executeKbCommand,
  },
];

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0];

  if (!name) {
    return undefined;
  }

  return {
    name,
    args: parts.slice(1),
  };
}

export async function executeSlashCommand(input: string, context: SlashCommandContext): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(input);

  if (!parsed) {
    return { messages: ["That is not a slash command."] };
  }

  const command = slashCommands.find((candidate) => candidate.name === parsed.name);

  if (!command) {
    return { messages: [`Unknown command: /${parsed.name}`, "Try /kb status."] };
  }

  return command.execute(parsed.args, context);
}

export function getSlashCommandSuggestions(input: string): SlashCommandSuggestion[] {
  const trimmed = input.trimStart();

  if (!trimmed.startsWith("/")) {
    return [];
  }

  const query = trimmed.toLowerCase();

  return slashCommandSuggestions.filter((suggestion) => suggestion.value.toLowerCase().startsWith(query));
}

async function executeKbCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const subcommand = args[0];

  if (subcommand === "status") {
    return { messages: formatKnowledgeStatus(getKnowledgeStatus(context.workspaceRoot)) };
  }

  if (subcommand === "init") {
    return { messages: formatKnowledgeInitResult(await initializeKnowledgeBase(context.workspaceRoot)) };
  }

  return { messages: ["Usage: /kb init or /kb status"] };
}

export function formatKnowledgeStatus(status: KnowledgeStatus): string[] {
  const lines = [
    "KB status",
    `workspace: ${status.workspaceRoot}`,
    `knowledge folder: ${formatPathStatus(status.kbPath, status.kbExists, status.kbIsDirectory)} (${status.kbPathSource})`,
    `local cache folder: ${formatPathStatus(status.cachePath, status.cacheExists, status.cacheIsDirectory)} (${status.cachePathSource})`,
  ];

  if (!status.kbExists) {
    lines.push("state: no knowledge base found yet");
  } else if (!status.kbIsDirectory) {
    lines.push("state: knowledge base path is not a folder");
  } else {
    lines.push("state: knowledge base found");
  }

  return lines;
}

function formatPathStatus(path: string, exists: boolean, isDirectory: boolean): string {
  if (!exists) {
    return `${path} [missing]`;
  }

  if (!isDirectory) {
    return `${path} [not a folder]`;
  }

  return `${path} [ok]`;
}
