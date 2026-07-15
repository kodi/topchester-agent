import { cwd } from "node:process";
import { isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { parseBenchmarkProfile, type BenchmarkProfile } from "./agent/benchmark-profile.js";
import { exchangeCodexAuthorizationCode, pollCodexDeviceAuthorization, requestCodexDeviceCode } from "./auth/codex.js";
import { getAuthStoreStatus, setAuthProvider } from "./auth/store.js";
import { createAppContext, restoreRuntimeConfigOverrides } from "./app/context.js";
import { ui } from "./cli/ui.js";
import { type L1FileScanStatus } from "./knowledge/compiler/l1-entry.js";
import {
  dryRunKnowledgeCompile,
  filterNonCleanKnowledgeCompileResult,
  formatKnowledgeCompileDryRunResult,
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
  stripEmptyContainers,
} from "./knowledge/search.js";
import { forkSession, loadSession, loadSessionForAppend, rehydrateSession } from "./session/store.js";
import { TopchesterTuiShell } from "./tui/index.js";
import { getTopchesterVersion } from "./version.js";
import { executeRunCommand } from "./cli/run.js";
import {
  checkSelfUpdate,
  formatSelfUpdateCheckResult,
  formatSelfUpdateSuccess,
  runSelfUpdate,
} from "./cli/self-update.js";
import { collectTopchesterInfo } from "./cli/info.js";
import {
  createSelectedKnowledgeContext,
  formatKnowledgeSources,
  formatKnowledgeSourcesJson,
  formatKnowledgeSourcesSearchResult,
  getKnowledgeSourceDescriptors,
  searchKnowledgeSources,
  type KnowledgeSourceSelection,
} from "./knowledge/sources/index.js";
import {
  addMcpStdioServerConfig,
  configureCodexGlobalProvider,
  getGlobalTopchesterConfigPath,
} from "./config/index.js";

export async function runTopchesterCli(argv = process.argv, options: { exitOverride?: boolean } = {}): Promise<void> {
  const program = createTopchesterProgram();
  if (options.exitOverride) {
    program.exitOverride();
  }
  await program.parseAsync(argv);
}

function createTopchesterProgram(): Command {
  const program = new Command();

  program
    .name("topchester")
    .description("KB-first terminal coding agent")
    .version(getTopchesterVersion())
    .configureHelp({ helpWidth: 120 });

  program
    .option("-c, --config <path>", "explicit config file path")
    .option("--workspace <path>", "workspace root", cwd())
    .option("--resume <session>", "resume a project session: latest or an exact session id")
    .option("--dev <flag>", "enable a development flag", collectDevFlag, []);

  program.action(async () => {
    const context = createContextFromOptions(program);
    const options = program.opts<{ resume?: string }>();

    try {
      if (options.resume) {
        const loaded = await loadSession(context.workspaceRoot, options.resume);
        const session = await loadSessionForAppend(context.workspaceRoot, loaded.sessionId);
        const rehydrated = rehydrateSession(loaded.events);
        const runtimeConfigWarnings = restoreRuntimeConfigOverrides(context, rehydrated.runtimeConfigOverrides);

        await new TopchesterTuiShell(context, undefined, {
          session,
          initialMessages: rehydrated.messages,
          initialTaskPlan: rehydrated.taskPlan,
          runtimeConfigWarnings,
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
      const context = createContextFromOptions(program);

      console.log("Topchester local dev mode");
      printStartupSummary(context);
    });

  program
    .command("info")
    .description("show config and local runtime hints")
    .action(async () => {
      const contextOptions = getContextOptionsFromProgram(program);
      const result = await collectTopchesterInfo(contextOptions);

      console.log(result.lines.join("\n"));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  const authCommand = program
    .command("auth")
    .description("manage global provider authentication")
    .addHelpText("after", formatAuthCommandHelp);

  authCommand
    .command("login")
    .usage("[options] <provider>")
    .description("log in to a provider")
    .argument("[provider]", "provider id")
    .option("--device", "use device-code login")
    .addHelpText("after", formatAuthLoginHelp)
    .action(async (provider: string | undefined, options: { device?: boolean }) => {
      try {
        await executeAuthLoginCommand(provider, options);
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    });

  authCommand
    .command("status")
    .description("show stored provider authentication status")
    .action(async () => {
      try {
        console.log((await formatAuthStatus()).join("\n"));
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    });

  const mcpCommand = program.command("mcp").description("manage MCP servers");

  mcpCommand
    .command("add")
    .usage("[options] <server-name> -- <stdio server-command>")
    .description("add or replace a stdio MCP server")
    .argument("<server-name>", "server name")
    .argument("<command...>", "stdio server command after --")
    .option("--env <KEY=VALUE>", "environment variable for the server process", collectEnvPair, {})
    .addHelpText("after", formatMcpAddHelp)
    .action(async (serverName: string, commandParts: string[], options: { env: Record<string, string> }) => {
      try {
        const [command, ...args] = commandParts;
        if (!command) {
          throw new Error("Usage: topchester mcp add <server-name> -- <stdio server-command>");
        }

        const result = await addMcpStdioServerConfig(getWritableConfigPathFromProgram(program), {
          serverName,
          command,
          args,
          env: options.env,
        });

        console.log(`${result.replaced ? "Updated" : "Added"} MCP stdio server "${result.serverName}".`);
        console.log(`config: ${result.path}`);
        console.log(`command: ${[result.command, ...result.args].join(" ")}`);
        if (Object.keys(result.env).length > 0) {
          console.log(`env: ${Object.keys(result.env).join(", ")}`);
        }
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    });

  program
    .command("run")
    .description("run one prompt or slash command without opening the TUI")
    .argument("<prompt...>", "prompt text or slash command")
    .option("--model <model>", "override the agent.primary model for this run")
    .option("--timeout <ms>", "timeout for the run in milliseconds", parsePositiveInteger)
    .option("--json", "write JSONL run events to stdout")
    .option("--output-json <path>", "write JSONL run events to a file")
    .option("--dangerously-auto-approve", "auto-approve prompt-gated tool calls for this non-interactive run")
    .option("--benchmark-profile <profile>", "enable an explicit benchmark runtime profile", parseBenchmarkProfile)
    .action(
      async (
        promptParts: string[],
        options: {
          model?: string;
          timeout?: number;
          json?: boolean;
          outputJson?: string;
          dangerouslyAutoApprove?: boolean;
          benchmarkProfile?: BenchmarkProfile;
        }
      ) => {
        const context = createContextFromOptions(program);
        const globalOptions = program.opts<{ resume?: string }>();

        try {
          await executeRunCommand(context, {
            prompt: promptParts.join(" "),
            model: options.model,
            timeoutMs: options.timeout,
            json: options.json,
            outputJson: options.outputJson,
            resume: globalOptions.resume,
            dangerouslyAutoApprove: options.dangerouslyAutoApprove,
            benchmarkProfile: options.benchmarkProfile,
          });
        } catch (error) {
          console.error(formatStartupError(error));
          process.exitCode = 1;
        }
      }
    );

  program
    .command("fork")
    .description("fork a saved project session")
    .argument("[session]", "session id to fork")
    .option("--last", "fork the latest project session")
    .action(async (sessionId: string | undefined, options: { last?: boolean }) => {
      const context = createContextFromOptions(program);

      try {
        if (options.last && sessionId) {
          throw new Error("Usage: topchester fork [--last] [session-id]");
        }

        const source = options.last ? "latest" : sessionId;
        if (!source) {
          throw new Error("topchester fork requires --last or a session id until a saved-session picker exists.");
        }

        await openForkedSession(context, source);
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    });

  program
    .command("search")
    .description("search compiled L1 knowledge entries")
    .argument("<query...>", "search query")
    .option("--limit <count>", "maximum number of matches", parsePositiveInteger)
    .option("--json", "write full JSON search result to stdout")
    .action(async (queryParts: string[], options: KbSearchCommandOptions) => {
      await executeKbSearchCommand(program, queryParts, options);
    });

  const kbCommand = program.command("kb").description("knowledge base commands");

  kbCommand
    .command("sources")
    .description("show available project and built-in knowledge sources")
    .option("--json", "write structured source diagnostics to stdout")
    .action(async (options: { json?: boolean }) => {
      const context = createContextFromOptions(program);
      const sources = await getKnowledgeSourceDescriptors(context.workspaceRoot);
      console.log(options.json ? formatKnowledgeSourcesJson(sources) : formatKnowledgeSources(sources).join("\n"));
    });

  kbCommand
    .command("init")
    .description("initialize a project knowledge base")
    .action(async () => {
      const context = createContextFromOptions(program);
      const result = await ui.progress("Preparing project knowledge folders...", (report) =>
        initializeKnowledgeBase(context.workspaceRoot, { onProgress: (event) => report(event.message) })
      );

      console.log(formatKnowledgeInitResult(result).join("\n"));
    });

  kbCommand
    .command("dry-run")
    .description("list project files that would be synced into the knowledge base")
    .action(async () => {
      const context = createContextFromOptions(program);
      const result = await ui.spinner("Listing project files for KB sync...", () =>
        dryRunKnowledgeCompile(context.workspaceRoot, { config: context.config })
      );

      console.log(formatKnowledgeCompileDryRunResult(result, { formatSyncStatus: formatDryRunSyncStatus }).join("\n"));
    });

  kbCommand
    .command("sync")
    .description("sync project files into the knowledge base")
    .option("--full", "sync all in-scope files and remove orphaned L1 entries")
    .action(async (options: { full?: boolean }) => {
      const context = createContextFromOptions(program);
      const result = await ui.progress(
        options.full ? "Syncing all L1 file entries..." : "Syncing non-clean L1 file entries...",
        (report) =>
          syncKnowledgeBase(context.workspaceRoot, {
            model: context.modelGateway,
            requireModel: true,
            config: context.config,
            full: options.full,
            onProgress: (event) => report(event.message),
          })
      );

      console.log(formatKnowledgeSyncResult(result, { title: options.full ? "KB sync --full" : "KB sync" }).join("\n"));
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
    .option("--source <source>", "knowledge source: project, topchester, or all", parseKnowledgeSourceSelection)
    .option("--json", "write full JSON search result to stdout")
    .action(async (queryParts: string[], options: KbSearchCommandOptions) => {
      await executeKbSearchCommand(program, queryParts, options);
    });

  kbCommand
    .command("context")
    .description("create an L1 context pack for a query")
    .argument("<query...>", "context query")
    .option("--limit <count>", "maximum number of relevant files", parsePositiveInteger)
    .option("--min-score <score>", "minimum match score", parseNonNegativeNumber)
    .option("--source <source>", "knowledge source: project, topchester, or all", parseKnowledgeSourceSelection)
    .option("--json", "write JSON context pack to stdout")
    .option("--full-l1", "include full raw L1 entries in JSON output")
    .action(async (queryParts: string[], options: KbContextCommandOptions) => {
      await executeKbContextCommand(program, queryParts, options);
    });

  kbCommand
    .command("reset")
    .description("delete the local project knowledge base and cache")
    .action(async () => {
      const context = createContextFromOptions(program);
      const result = await ui.progress("Resetting project knowledge base...", (report) =>
        resetKnowledgeBase(context.workspaceRoot, { onProgress: (event) => report(event.message) })
      );

      console.log(formatKnowledgeResetResult(result).join("\n"));
    });

  kbCommand
    .command("status")
    .description("show project files that are not current in the knowledge base")
    .action(async () => {
      const context = createContextFromOptions(program);
      const result = await ui.spinner("Checking KB file status...", async () =>
        filterNonCleanKnowledgeCompileResult(
          await dryRunKnowledgeCompile(context.workspaceRoot, { config: context.config })
        )
      );

      console.log(formatKnowledgeCompileStatusResult(result, { formatSyncStatus: formatDryRunSyncStatus }).join("\n"));
    });

  program
    .command("update")
    .alias("upgrade")
    .description("update Topchester with the package manager that installed it")
    .argument("[target]", "version or npm dist tag to install", "latest")
    .option("--check", "check the available version without updating")
    .action(async (target: string, options: { check?: boolean }) => {
      try {
        if (options.check) {
          const result = await checkSelfUpdate({ target, currentVersion: getTopchesterVersion() });
          console.log(formatSelfUpdateCheckResult(result).join("\n"));
          return;
        }

        const command = await runSelfUpdate({ target });
        console.log(formatSelfUpdateSuccess(command).join("\n"));
      } catch (error) {
        console.error(formatStartupError(error));
        process.exitCode = 1;
      }
    });

  return program;
}

function printStartupSummary(context: ReturnType<typeof createAppContext>) {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.providers ?? {};

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

interface AuthProviderHelp {
  id: string;
  name: string;
  auth: string;
  example: string;
}

const AUTH_PROVIDERS: AuthProviderHelp[] = [
  {
    id: "codex",
    name: "Codex / ChatGPT",
    auth: "OAuth device-code login for Codex-backed model access.",
    example: "topchester auth login codex --device",
  },
];

function formatAuthCommandHelp(): string {
  return [
    "",
    ui.label("Supported providers:"),
    ...AUTH_PROVIDERS.map(
      (provider) => `  ${ui.modelInline(provider.id.padEnd(8))} ${provider.name} - ${provider.auth}`
    ),
    "",
    ui.label("Examples:"),
    ...AUTH_PROVIDERS.map((provider) => `  ${provider.example}`),
    "  topchester auth status",
  ].join("\n");
}

function formatAuthLoginHelp(): string {
  return [
    "",
    ui.label("Supported providers:"),
    ...AUTH_PROVIDERS.map((provider) => `  ${ui.modelInline(provider.id.padEnd(8))} ${provider.auth}`),
    "",
    ui.label("Examples:"),
    ...AUTH_PROVIDERS.map((provider) => `  ${provider.example}`),
    "",
    ui.label("What happens:"),
    "  Topchester prints a browser URL and one-time code, waits for approval, then stores tokens in the global auth store.",
  ].join("\n");
}

function formatMcpAddHelp(): string {
  return [
    "",
    ui.label("Examples:"),
    "  topchester mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .",
    "  topchester mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- npx -y @modelcontextprotocol/server-github",
    "",
    ui.label("What happens:"),
    "  Writes to --config when provided, otherwise to the global user config.",
  ].join("\n");
}

function formatAuthLoginUsageError(reason: string): string {
  return [
    ui.error(reason),
    "",
    ui.label("Usage:"),
    "  topchester auth login <provider> --device",
    "",
    ui.label("Supported providers:"),
    ...AUTH_PROVIDERS.map((provider) => `  ${provider.id.padEnd(8)} ${provider.name} - ${provider.auth}`),
    "",
    ui.label("Examples:"),
    ...AUTH_PROVIDERS.map((provider) => `  ${provider.example}`),
    "",
    "Run `topchester auth login --help` for details.",
  ].join("\n");
}

async function executeAuthLoginCommand(provider: string | undefined, options: { device?: boolean }) {
  if (!provider) {
    throw new Error(formatAuthLoginUsageError("Missing provider."));
  }

  if (provider !== "codex") {
    throw new Error(formatAuthLoginUsageError(`Unsupported auth provider "${provider}".`));
  }

  if (!options.device) {
    throw new Error(formatAuthLoginUsageError('Codex login currently requires "--device".'));
  }

  const deviceCode = await requestCodexDeviceCode();
  console.log(ui.heading("Codex device login"));
  console.log(`${ui.label("verification URL:")} ${deviceCode.verificationUrl}`);
  console.log(`${ui.label("user code:")} ${ui.inverse(deviceCode.userCode)}`);
  console.log(`${ui.label("expires:")} ${new Date(deviceCode.expiresAt).toISOString()}`);
  console.log(ui.warn("Device codes are a common phishing target. Never share this code."));
  console.log(ui.label("Waiting for browser approval..."));

  const authorization = await pollCodexDeviceAuthorization(deviceCode);
  const record = await exchangeCodexAuthorizationCode(authorization, { issuer: deviceCode.issuer });
  await setAuthProvider("codex", record);
  await configureCodexGlobalProvider();

  console.log(ui.ok("Codex login saved."));
  console.log("Configured global Codex provider and starter model choices.");
}

async function formatAuthStatus(): Promise<string[]> {
  const status = await getAuthStoreStatus();
  const lines = ["Topchester auth status", `store: ${status.path} ${status.exists ? "[ok]" : "[missing]"}`];

  if (status.error) {
    lines.push("status: invalid", `error: ${status.error}`);
    return lines;
  }

  if (status.providers.length === 0) {
    lines.push("providers: none");
    return lines;
  }

  lines.push("providers:");
  for (const provider of status.providers) {
    const state = provider.needsLogin ? "needs-login" : provider.needsRefresh ? "needs-refresh" : "ok";
    const expires = provider.expiresAt ? ` expires=${new Date(provider.expiresAt).toISOString()}` : "";
    const account = provider.hasAccountId ? " account=yes" : "";
    lines.push(
      `  ${provider.id}: ${provider.type} source=${provider.source} state=${state} access=${formatYesNo(provider.hasAccessToken)} refresh=${formatYesNo(provider.hasRefreshToken)}${account}${expires}`
    );
  }

  return lines;
}

async function openForkedSession(context: ReturnType<typeof createContextFromOptions>, sourceSession: string) {
  const fork = await forkSession(context.workspaceRoot, sourceSession);
  const loaded = await loadSession(context.workspaceRoot, fork.sessionId);
  const session = await loadSessionForAppend(context.workspaceRoot, loaded.sessionId);
  const rehydrated = rehydrateSession(loaded.events);
  const runtimeConfigWarnings = restoreRuntimeConfigOverrides(context, rehydrated.runtimeConfigOverrides);

  await new TopchesterTuiShell(context, undefined, {
    session,
    initialMessages: rehydrated.messages,
    initialTaskPlan: rehydrated.taskPlan,
    runtimeConfigWarnings,
  }).render();
}

function createContextFromOptions(program: Command) {
  return createAppContext(getContextOptionsFromProgram(program));
}

function getContextOptionsFromProgram(program: Command) {
  const options = program.opts<{ config?: string; workspace: string; dev: string[] }>();

  return {
    workspaceRoot: options.workspace,
    configPath: options.config && (isAbsolute(options.config) ? options.config : resolve(cwd(), options.config)),
    devFlags: options.dev,
  };
}

function getWritableConfigPathFromProgram(program: Command): string {
  const options = program.opts<{ config?: string }>();
  return options.config
    ? isAbsolute(options.config)
      ? options.config
      : resolve(cwd(), options.config)
    : getGlobalTopchesterConfigPath();
}

interface KbSearchCommandOptions {
  limit?: number;
  json?: boolean;
  source?: KnowledgeSourceSelection;
}

interface KbContextCommandOptions {
  limit?: number;
  minScore?: number;
  json?: boolean;
  fullL1?: boolean;
  source?: KnowledgeSourceSelection;
}

async function executeKbSearchCommand(program: Command, queryParts: string[], options: KbSearchCommandOptions) {
  const context = createContextFromOptions(program);
  const query = queryParts.join(" ");
  if (options.source && options.source !== "project") {
    const result = await searchKnowledgeSources(context.workspaceRoot, query, options.source, { limit: options.limit });
    console.log(
      options.json ? formatKnowledgeSourcesJson(result) : formatKnowledgeSourcesSearchResult(result).join("\n")
    );
    return;
  }
  const result = options.json
    ? await searchL1Knowledge(context.workspaceRoot, query, { limit: options.limit })
    : await ui.spinner("Searching L1 knowledge entries...", () =>
        searchL1Knowledge(context.workspaceRoot, query, { limit: options.limit })
      );

  if (options.json) {
    console.log(JSON.stringify(stripEmptyContainers(result), null, 2));
    return;
  }

  console.log(formatL1KnowledgeSearchResult(result).join("\n"));
}

async function executeKbContextCommand(program: Command, queryParts: string[], options: KbContextCommandOptions) {
  const context = createContextFromOptions(program);
  const query = queryParts.join(" ");
  const contextPackOptions = {
    limit: options.limit,
    minScore: options.minScore,
    includeFullL1: options.fullL1,
  };
  if (options.source && options.source !== "project") {
    const result = await createSelectedKnowledgeContext(
      context.workspaceRoot,
      query,
      options.source,
      contextPackOptions
    );
    if (!result.contextPack) {
      const warning =
        result.warnings.length > 0 ? result.warnings.join(" ") : "No L1 entries met the context pack score threshold.";
      if (options.json) {
        console.log(formatKnowledgeSourcesJson(result));
      } else {
        console.log(`KB context\nsource selection: ${options.source}\nwarning: ${warning}\nrelevant files: 0`);
      }
      return;
    }
    console.log(
      options.json
        ? formatKnowledgeSourcesJson({
            ...result.contextPack,
            sourceSelection: options.source,
            sourceWarnings: result.warnings,
          })
        : formatL1ContextPackResult(result.contextPack).join("\n")
    );
    return;
  }
  const result = options.json
    ? await createL1ContextPack(context.workspaceRoot, query, contextPackOptions)
    : await ui.spinner("Creating L1 context pack...", () =>
        createL1ContextPack(context.workspaceRoot, query, contextPackOptions)
      );

  if (options.json) {
    console.log(JSON.stringify(stripEmptyContainers(result), null, 2));
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

function collectEnvPair(raw: string, env: Record<string, string>): Record<string, string> {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error("Environment entries must be in KEY=VALUE form.");
  }

  const key = raw.slice(0, separatorIndex).trim();
  if (!key) {
    throw new Error("Environment entries must be in KEY=VALUE form.");
  }

  return {
    ...env,
    [key]: raw.slice(separatorIndex + 1),
  };
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

function parseKnowledgeSourceSelection(value: string): KnowledgeSourceSelection {
  if (value === "project" || value === "topchester" || value === "all") return value;
  throw new Error('Expected --source to be "project", "topchester", or "all".');
}

function formatYesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
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
