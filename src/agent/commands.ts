import {
  compileKnowledgeBase,
  formatKnowledgeCompileResult,
  formatKnowledgeSyncResult,
  syncKnowledgeBase,
} from "../knowledge/compiler/index.js";
import { type L1SummaryModel } from "../knowledge/compiler/l1-processor.js";
import { type TopchesterConfig } from "../config/index.js";
import { formatKnowledgeInitResult, initializeKnowledgeBase } from "../knowledge/init.js";
import { type KnowledgeProgressReporter } from "../knowledge/progress.js";
import { formatKnowledgeResetResult, resetKnowledgeBase } from "../knowledge/reset.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";

export interface SlashCommandContext {
  workspaceRoot: string;
  config?: TopchesterConfig;
  modelGateway?: L1SummaryModel;
  onProgress?: KnowledgeProgressReporter;
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
    value: "/kb compile",
    description: "process project files into L1 entries",
  },
  {
    value: "/kb sync",
    description: "process non-clean project files into L1 entries",
  },
  {
    value: "/kb init",
    description: "start project knowledge base setup",
  },
  {
    value: "/kb reset",
    description: "delete the local knowledge base and cache",
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

  if (subcommand === "compile" || subcommand === "sync") {
    if (!context.modelGateway) {
      return { messages: ['No model configured for purpose "kb.summarize"; L1 entries were not processed.'] };
    }

    try {
      const action = subcommand === "sync" ? syncKnowledgeBase : compileKnowledgeBase;
      const format = subcommand === "sync" ? formatKnowledgeSyncResult : formatKnowledgeCompileResult;
      return {
        messages: format(
          await action(context.workspaceRoot, {
            model: context.modelGateway,
            requireModel: true,
            config: context.config,
            onProgress: context.onProgress,
          })
        ),
      };
    } catch (error) {
      return {
        messages: [`KB ${subcommand} failed: ${error instanceof Error ? error.message : "Unknown error."}`],
      };
    }
  }

  if (subcommand === "reset") {
    return { messages: formatKnowledgeResetResult(await resetKnowledgeBase(context.workspaceRoot)) };
  }

  return { messages: ["Usage: /kb init, /kb compile, /kb sync, /kb reset, or /kb status"] };
}

export function formatKnowledgeStatus(status: KnowledgeStatus): string[] {
  const lines = [
    "KB status",
    `workspace: ${status.workspaceRoot}`,
    `knowledge folder: ${formatKnowledgePathStatus(status)} (${status.kbPathSource})`,
    `local cache folder: ${formatPathStatus(status.cachePath, status.cacheExists, status.cacheIsDirectory)} (${status.cachePathSource})`,
  ];

  if (!status.kbExists) {
    lines.push("state: no knowledge base found yet");
  } else if (!status.kbIsDirectory) {
    lines.push("state: knowledge base path is not a folder");
  } else if (status.kbContentState !== "ready") {
    lines.push("state: knowledge base folder is empty");
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

function formatKnowledgePathStatus(status: KnowledgeStatus): string {
  if (!status.kbExists) {
    return `${status.kbPath} [missing]`;
  }

  if (!status.kbIsDirectory) {
    return `${status.kbPath} [not a folder]`;
  }

  if (status.kbContentState !== "ready") {
    return `${status.kbPath} [empty]`;
  }

  return `${status.kbPath} [ok]`;
}
