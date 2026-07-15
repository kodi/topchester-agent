import {
  dryRunKnowledgeCompile,
  filterNonCleanKnowledgeCompileResult,
  formatKnowledgeCompileStatusResult,
  formatKnowledgeSyncResult,
  syncKnowledgeBase,
} from "../knowledge/compiler/index.js";
import { type L1SummaryModel } from "../knowledge/compiler/l1-processor.js";
import { reasoningEfforts, type TopchesterConfig } from "../config/index.js";
import { formatKnowledgeInitResult, initializeKnowledgeBase } from "../knowledge/init.js";
import { type KnowledgeProgressReporter } from "../knowledge/progress.js";
import { formatKnowledgeResetResult, resetKnowledgeBase } from "../knowledge/reset.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { type L1FileScanStatus } from "../knowledge/compiler/l1-entry.js";
import { formatKnowledgeSources, getKnowledgeSourceDescriptors } from "../knowledge/sources/index.js";
import { ui } from "../cli/ui.js";
import {
  createSkillsService,
  formatSkillActivationPrompt,
  type SkillActivation,
  type SkillsService,
} from "../skills/index.js";

export interface SlashCommandContext {
  workspaceRoot: string;
  config?: TopchesterConfig;
  modelGateway?: L1SummaryModel;
  onProgress?: KnowledgeProgressReporter;
  formatSyncStatus?: (status: L1FileScanStatus) => string;
  skillsService?: SkillsService;
}

export interface SlashCommandResult {
  messages: string[];
  skillActivation?: SkillActivation;
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
    value: "/model",
    description: "choose from configured model choices",
  },
  {
    value: "/model all",
    description: "browse OpenRouter models",
  },
  {
    value: "/connect",
    description: "connect a model provider",
  },
  {
    value: "/effort",
    description: `show or set reasoning effort (${reasoningEfforts.join(", ")}, clear)`,
  },
  {
    value: "/reasoning",
    description: `show or set reasoning effort (${reasoningEfforts.join(", ")}, clear)`,
  },
  {
    value: "/kb sources",
    description: "show project and built-in knowledge sources",
  },
  {
    value: "/kb status",
    description: "show non-clean knowledge files",
  },
  {
    value: "/kb sync",
    description: "process non-clean project files into L1 entries",
  },
  {
    value: "/kb sync --full",
    description: "process all project files into L1 entries",
  },
  {
    value: "/kb init",
    description: "start project knowledge base setup",
  },
  {
    value: "/kb reset",
    description: "delete the local knowledge base and cache",
  },
  {
    value: "/skills",
    description: "open skills",
  },
  {
    value: "/skills list",
    description: "list available skills",
  },
  {
    value: "/skills inspect",
    description: "show one skill without activating it",
  },
  {
    value: "/skills reload",
    description: "reload skill discovery",
  },
  {
    value: "/skill",
    description: "activate a skill",
  },
  {
    value: "/queue",
    description: "queue a follow-up prompt",
  },
  {
    value: "/q",
    description: "queue a follow-up prompt",
  },
  {
    value: "/steer",
    description: "steer the active turn",
  },
  {
    value: "/new",
    description: "start a fresh session",
  },
  {
    value: "/fork",
    description: "fork the current session",
  },
  {
    value: "/restore",
    description: "restore a previous session",
  },
];

export const slashCommands: SlashCommand[] = [
  {
    name: "kb",
    description: "knowledge base commands",
    execute: executeKbCommand,
  },
  {
    name: "model",
    description: "choose from configured model choices",
    execute: executeInteractiveOnlyCommand("/model"),
  },
  {
    name: "models",
    description: "choose from configured model choices",
    execute: executeInteractiveOnlyCommand("/models"),
  },
  {
    name: "connect",
    description: "connect a model provider",
    execute: executeInteractiveOnlyCommand("/connect"),
  },
  {
    name: "effort",
    description: "show or set reasoning effort",
    execute: executeInteractiveOnlyCommand("/effort"),
  },
  {
    name: "reasoning",
    description: "show or set reasoning effort",
    execute: executeInteractiveOnlyCommand("/reasoning"),
  },
  {
    name: "provider",
    description: "connect a model provider",
    execute: executeInteractiveOnlyCommand("/provider"),
  },
  {
    name: "providers",
    description: "connect a model provider",
    execute: executeInteractiveOnlyCommand("/providers"),
  },
  {
    name: "skills",
    description: "skills commands",
    execute: executeSkillsCommand,
  },
  {
    name: "skill",
    description: "activate a skill",
    execute: executeSkillCommand,
  },
  {
    name: "new",
    description: "start a fresh interactive TUI session",
    execute: executeNewCommand,
  },
  {
    name: "fork",
    description: "fork the current interactive TUI session",
    execute: executeForkCommand,
  },
  {
    name: "restore",
    description: "restore a previous interactive TUI session",
    execute: executeRestoreCommand,
  },
  {
    name: "queue",
    description: "queue a follow-up prompt",
    execute: executeInteractiveOnlyCommand("/queue"),
  },
  {
    name: "q",
    description: "queue a follow-up prompt",
    execute: executeInteractiveOnlyCommand("/q"),
  },
  {
    name: "steer",
    description: "steer the active turn",
    execute: executeInteractiveOnlyCommand("/steer"),
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
    const shortcutResult = await executeSkillShortcutCommand(parsed.name, parsed.args, context);
    if (shortcutResult) {
      return shortcutResult;
    }

    return { messages: [`Unknown command: /${parsed.name}`, "Try /kb status, /new, /fork, or /restore."] };
  }

  return command.execute(parsed.args, context);
}

async function executeSkillsCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const service = getSkillsService(context);
  const subcommand = args[0];

  if (!subcommand) {
    return { messages: ["Skills overlay is available in the interactive TUI.", "Run /skills list to print skills."] };
  }

  if (subcommand === "list") {
    return { messages: formatSkillsListCommand(await service.listSkills()) };
  }

  if (subcommand === "inspect") {
    const name = args[1];
    if (!name) {
      return { messages: ["Usage: /skills inspect <name>"] };
    }

    try {
      const skill = await service.viewSkill(name);

      return {
        messages: [`${skill.name}\nsource: ${formatSkillSource(skill)}\npath: ${skill.skillFile}\n\n${skill.content}`],
      };
    } catch (error) {
      return { messages: [`Skill inspect failed: ${error instanceof Error ? error.message : "Unknown error."}`] };
    }
  }

  if (subcommand === "reload") {
    service.reload();
    const skills = await service.listSkills();

    return { messages: [`Skills reloaded.\nactive: ${skills.active.length}\nshadowed: ${skills.shadowed.length}`] };
  }

  return { messages: ["Usage: /skills, /skills list, /skills inspect <name>, or /skills reload"] };
}

async function executeSkillCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const name = args[0];

  if (!name) {
    return { messages: ["Usage: /skill <name> [instruction]"] };
  }

  try {
    return await activateSkill(name, args.slice(1).join(" "), context);
  } catch (error) {
    return { messages: [`Skill activation failed: ${error instanceof Error ? error.message : "Unknown error."}`] };
  }
}

async function executeSkillShortcutCommand(
  name: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult | undefined> {
  try {
    return await activateSkill(name, args.join(" "), context);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown skill:")) {
      return undefined;
    }

    return { messages: [`Skill activation failed: ${error instanceof Error ? error.message : "Unknown error."}`] };
  }
}

async function activateSkill(
  name: string,
  instruction: string,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const skill = await getSkillsService(context).viewSkill(name);
  const activation = { skill, instruction: instruction.trim() || "Use this skill for the next user request." };

  return {
    messages: [
      `Skill activated: ${skill.name}`,
      instruction.trim()
        ? formatSkillActivationPrompt([activation])
        : "No instruction was provided, so the interactive TUI will apply it to the next message.",
    ],
    skillActivation: activation,
  };
}

function getSkillsService(context: SlashCommandContext): SkillsService {
  return context.skillsService ?? createSkillsService({ workspaceRoot: context.workspaceRoot });
}

function formatSkillsListCommand(skills: Awaited<ReturnType<SkillsService["listSkills"]>>): string[] {
  if (skills.active.length === 0) {
    return ["No skills found."];
  }

  const lines = skills.active.flatMap((skill) => [
    `${ui.model(skill.name.padEnd(24))} ${ui.muted(formatSkillSource(skill))}`,
    `  ${skill.description}`,
  ]);

  if (skills.shadowed.length > 0) {
    lines.push("", `shadowed: ${skills.shadowed.length}`);
  }

  return lines;
}

function formatSkillSource(skill: { source: string; compatibilitySource?: string }): string {
  return skill.compatibilitySource ? `${skill.source}:${skill.compatibilitySource}` : skill.source;
}

export function getSlashCommandSuggestions(input: string): SlashCommandSuggestion[] {
  const trimmed = input.trimStart();

  if (!trimmed.startsWith("/")) {
    return [];
  }

  const query = trimmed.toLowerCase();
  const reasoningSuggestions = getReasoningEffortValueSuggestions(query);

  if (reasoningSuggestions) {
    return reasoningSuggestions;
  }

  return slashCommandSuggestions.filter((suggestion) => suggestion.value.toLowerCase().startsWith(query));
}

function getReasoningEffortValueSuggestions(query: string): SlashCommandSuggestion[] | undefined {
  const match = /^\/(?<command>effort|reasoning)\s+(?<value>\S*)$/u.exec(query);

  if (!match?.groups) {
    return undefined;
  }

  const command = match.groups.command;
  const valuePrefix = match.groups.value;
  const options = [...reasoningEfforts, "clear", "default"];

  return options
    .filter((option) => option.startsWith(valuePrefix))
    .map((option) => ({
      value: `/${command} ${option}`,
      description:
        option === "clear" || option === "default"
          ? "use provider default reasoning effort"
          : `set reasoning effort to ${option}`,
    }));
}

async function executeKbCommand(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const subcommand = args[0];

  if (subcommand === "status") {
    const result = filterNonCleanKnowledgeCompileResult(
      await dryRunKnowledgeCompile(context.workspaceRoot, { config: context.config })
    );

    return {
      messages: formatKnowledgeCompileStatusResult(result, { formatSyncStatus: context.formatSyncStatus }),
    };
  }

  if (subcommand === "sources") {
    if (args.length > 1) return { messages: ["Usage: /kb sources"] };
    return { messages: formatKnowledgeSources(await getKnowledgeSourceDescriptors(context.workspaceRoot)) };
  }

  if (subcommand === "init") {
    return { messages: formatKnowledgeInitResult(await initializeKnowledgeBase(context.workspaceRoot)) };
  }

  if (subcommand === "sync") {
    const full = args.includes("--full");
    const unknownArgs = args.slice(1).filter((arg) => arg !== "--full");
    if (unknownArgs.length > 0) {
      return { messages: ["Usage: /kb sync [--full]"] };
    }
    try {
      return {
        messages: formatKnowledgeSyncResult(
          await syncKnowledgeBase(context.workspaceRoot, {
            model: context.modelGateway,
            requireModel: true,
            config: context.config,
            full,
            onProgress: context.onProgress,
          }),
          { title: full ? "KB sync --full" : "KB sync" }
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

  return { messages: ["Usage: /kb init, /kb sync [--full], /kb reset, /kb status, or /kb sources"] };
}

function executeNewCommand(): SlashCommandResult {
  return {
    messages: ["/new starts a fresh session in the interactive TUI."],
  };
}

function executeForkCommand(): SlashCommandResult {
  return {
    messages: ["/fork clones the current session in the interactive TUI."],
  };
}

function executeRestoreCommand(): SlashCommandResult {
  return {
    messages: ["/restore opens a previous-session picker in the interactive TUI."],
  };
}

function executeInteractiveOnlyCommand(command: string): () => SlashCommandResult {
  return () => ({
    messages: [`${command} is available in the interactive TUI.`],
  });
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
