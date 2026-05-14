#!/usr/bin/env node
import { cwd } from "node:process";
import { isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { createAppContext } from "./app/context.js";
import { ui } from "./cli/ui.js";
import { type L1FileScanStatus } from "./knowledge/compiler/l1-entry.js";
import {
  compileKnowledgeBase,
  dryRunKnowledgeCompile,
  filterNonCleanKnowledgeCompileResult,
  formatKnowledgeCompileDryRunResult,
  formatKnowledgeCompileResult,
  formatKnowledgeCompileStatusResult,
  formatKnowledgeSyncResult,
  isPartialKnowledgeCompileResult,
  syncKnowledgeBase,
} from "./knowledge/compiler/index.js";
import { formatKnowledgeInitResult, initializeKnowledgeBase } from "./knowledge/init.js";
import { formatKnowledgeResetResult, resetKnowledgeBase } from "./knowledge/reset.js";
import {
  createL1ContextPack,
  formatL1ContextPackResult,
  formatL1KnowledgeSearchResult,
  searchL1Knowledge,
} from "./knowledge/search.js";
import { loadSession, loadSessionForAppend, rehydrateSession } from "./session/store.js";
import { TopchesterTuiShell } from "./tui/index.js";
import { getTopchesterVersion } from "./version.js";
import { executeRunCommand } from "./cli/run.js";

const program = new Command();

program.name("topchester").description("KB-first terminal coding agent").version(getTopchesterVersion());

program
  .option("-c, --config <path>", "explicit config file path")
  .option("--workspace <path>", "workspace root", cwd())
  .option("--resume <session>", "resume a project session: latest or an exact session id")
  .option("--dev <flag>", "enable a development flag", collectDevFlag, []);

program.action(async () => {
  const context = createContextFromOptions();
  const options = program.opts<{ resume?: string }>();

  try {
    if (options.resume) {
      const loaded = await loadSession(context.workspaceRoot, options.resume);
      const session = await loadSessionForAppend(context.workspaceRoot, loaded.sessionId);
      const rehydrated = rehydrateSession(loaded.events);

      await new TopchesterTuiShell(context, undefined, {
        session,
        initialMessages: rehydrated.messages,
        initialTaskPlan: rehydrated.taskPlan,
      }).render();
      return;
    }

    await new TopchesterTuiShell(context).render();
  } catch (error) {
    console.error(formatStartupError(error));
    process.exitCode = 1;
  }
});

program
  .command("dev")
  .description("start local development mode")
  .action(() => {
    const context = createContextFromOptions();

    console.log("Topchester local dev mode");
    printStartupSummary(context);
  });

program
  .command("run")
  .description("run one prompt or slash command without opening the TUI")
  .argument("<prompt...>", "prompt text or slash command")
  .option("--model <model>", "override the agent.primary model for this run")
  .option("--timeout <ms>", "timeout for the run in milliseconds", parsePositiveInteger)
  .option("--json", "write JSONL run events to stdout")
  .option("--output-json <path>", "write JSONL run events to a file")
  .action(
    async (
      promptParts: string[],
      options: { model?: string; timeout?: number; json?: boolean; outputJson?: string }
    ) => {
      const context = createContextFromOptions();
      const globalOptions = program.opts<{ resume?: string }>();

      try {
        await executeRunCommand(context, {
          prompt: promptParts.join(" "),
          model: options.model,
          timeoutMs: options.timeout,
          json: options.json,
          outputJson: options.outputJson,
          resume: globalOptions.resume,
        });
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    }
  );

program
  .command("search")
  .description("search compiled L1 knowledge entries")
  .argument("<query...>", "search query")
  .option("--limit <count>", "maximum number of matches", parsePositiveInteger)
  .option("--json", "write full JSON search result to stdout")
  .action(async (queryParts: string[], options: KbSearchCommandOptions) => {
    await executeKbSearchCommand(queryParts, options);
  });

const kbCommand = program.command("kb").description("knowledge base commands");

kbCommand
  .command("init")
  .description("initialize a project knowledge base")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.progress("Preparing project knowledge folders...", (report) =>
      initializeKnowledgeBase(context.workspaceRoot, { onProgress: (event) => report(event.message) })
    );

    console.log(formatKnowledgeInitResult(result).join("\n"));
  });

kbCommand
  .command("compile")
  .description("compile the project knowledge base")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.progress("Processing L1 file entries...", (report) =>
      compileKnowledgeBase(context.workspaceRoot, {
        model: context.modelGateway,
        requireModel: true,
        config: context.config,
        onProgress: (event) => report(event.message),
      })
    );

    console.log(formatKnowledgeCompileResult(result).join("\n"));
    if (isPartialKnowledgeCompileResult(result)) {
      process.exitCode = 2;
    }
  });

kbCommand
  .command("dry-run")
  .description("list project files that would be compiled into the knowledge base")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.spinner("Listing project files for KB compile...", () =>
      dryRunKnowledgeCompile(context.workspaceRoot, { config: context.config })
    );

    console.log(formatKnowledgeCompileDryRunResult(result, { formatSyncStatus: formatDryRunSyncStatus }).join("\n"));
  });

kbCommand
  .command("sync")
  .description("sync non-clean project files into the knowledge base")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.progress("Syncing non-clean L1 file entries...", (report) =>
      syncKnowledgeBase(context.workspaceRoot, {
        model: context.modelGateway,
        requireModel: true,
        config: context.config,
        onProgress: (event) => report(event.message),
      })
    );

    console.log(formatKnowledgeSyncResult(result).join("\n"));
    if (isPartialKnowledgeCompileResult(result)) {
      process.exitCode = 2;
    }
  });

kbCommand
  .command("search")
  .alias("query")
  .description("search compiled L1 knowledge entries")
  .argument("<query...>", "search query")
  .option("--limit <count>", "maximum number of matches", parsePositiveInteger)
  .option("--json", "write full JSON search result to stdout")
  .action(async (queryParts: string[], options: KbSearchCommandOptions) => {
    await executeKbSearchCommand(queryParts, options);
  });

kbCommand
  .command("context")
  .description("create an L1 context pack for a query")
  .argument("<query...>", "context query")
  .option("--limit <count>", "maximum number of relevant files", parsePositiveInteger)
  .option("--min-score <score>", "minimum match score", parseNonNegativeNumber)
  .option("--json", "write JSON context pack to stdout")
  .option("--full-l1", "include full raw L1 entries in JSON output")
  .action(async (queryParts: string[], options: KbContextCommandOptions) => {
    await executeKbContextCommand(queryParts, options);
  });

kbCommand
  .command("reset")
  .description("delete the local project knowledge base and cache")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.progress("Resetting project knowledge base...", (report) =>
      resetKnowledgeBase(context.workspaceRoot, { onProgress: (event) => report(event.message) })
    );

    console.log(formatKnowledgeResetResult(result).join("\n"));
  });

kbCommand
  .command("status")
  .description("show project files that are not current in the knowledge base")
  .action(async () => {
    const context = createContextFromOptions();
    const result = await ui.spinner("Checking KB file status...", async () =>
      filterNonCleanKnowledgeCompileResult(
        await dryRunKnowledgeCompile(context.workspaceRoot, { config: context.config })
      )
    );

    console.log(formatKnowledgeCompileStatusResult(result, { formatSyncStatus: formatDryRunSyncStatus }).join("\n"));
  });

await program.parseAsync();

function printStartupSummary(context: ReturnType<typeof createAppContext>) {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};

  console.log(`workspace: ${context.workspaceRoot}`);
  console.log(`default model purpose: ${context.config.models?.defaultPurpose ?? "agent.primary"}`);
  if (context.devFlags.size > 0) {
    console.log(`dev flags: ${[...context.devFlags].join(", ")}`);
  }
  if (context.logFilePath) {
    console.log(`log file: ${context.logFilePath}`);
  }

  if (Object.keys(assignments).length === 0) {
    console.log("model assignments: none configured");
  } else {
    console.log("model assignments:");
    for (const [purpose, model] of Object.entries(assignments)) {
      const provider = model.provider ? ` [${model.provider}]` : "";
      console.log(`  ${purpose}: ${model.name}${provider}`);
    }
  }

  const namedProviders = Object.entries(providers).filter(([providerId]) => providerId !== "default");

  if (namedProviders.length === 0) {
    console.log("providers: none configured");
  } else {
    console.log("providers:");
    if (typeof providers.default === "string") {
      console.log(`  default: ${providers.default}`);
    }
    for (const [providerId, provider] of namedProviders) {
      if (typeof provider === "string") {
        continue;
      }
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      console.log(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }
}

function createContextFromOptions() {
  const options = program.opts<{ config?: string; workspace: string; dev: string[] }>();

  return createAppContext({
    workspaceRoot: options.workspace,
    configPath: options.config && (isAbsolute(options.config) ? options.config : resolve(cwd(), options.config)),
    devFlags: options.dev,
  });
}

interface KbSearchCommandOptions {
  limit?: number;
  json?: boolean;
}

interface KbContextCommandOptions {
  limit?: number;
  minScore?: number;
  json?: boolean;
  fullL1?: boolean;
}

async function executeKbSearchCommand(queryParts: string[], options: KbSearchCommandOptions) {
  const context = createContextFromOptions();
  const query = queryParts.join(" ");
  const result = options.json
    ? await searchL1Knowledge(context.workspaceRoot, query, { limit: options.limit })
    : await ui.spinner("Searching L1 knowledge entries...", () =>
        searchL1Knowledge(context.workspaceRoot, query, { limit: options.limit })
      );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatL1KnowledgeSearchResult(result).join("\n"));
}

async function executeKbContextCommand(queryParts: string[], options: KbContextCommandOptions) {
  const context = createContextFromOptions();
  const query = queryParts.join(" ");
  const contextPackOptions = {
    limit: options.limit,
    minScore: options.minScore,
    includeFullL1: options.fullL1,
  };
  const result = options.json
    ? await createL1ContextPack(context.workspaceRoot, query, contextPackOptions)
    : await ui.spinner("Creating L1 context pack...", () =>
        createL1ContextPack(context.workspaceRoot, query, contextPackOptions)
      );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatL1ContextPackResult(result).join("\n"));
}

function formatStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Could not read session metadata") ||
    message.includes("Could not read session event") ||
    message.includes("ENOENT")
  ) {
    return message.includes("metadata.json") || message.includes("events.jsonl") ? message : "Session not found";
  }

  return message;
}

function collectDevFlag(flag: string, flags: string[]): string[] {
  return [...flags, flag];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer.");
  }

  return parsed;
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Expected a non-negative number.");
  }

  return parsed;
}

function formatDryRunSyncStatus(status: L1FileScanStatus): string {
  if (status === "current") {
    return ui.ok(status);
  }

  if (status === "invalid" || status === "missing_file") {
    return ui.error(status);
  }

  return ui.warn(status);
}
