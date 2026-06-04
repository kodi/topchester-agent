import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { getAuthStoreStatus, type AuthStoreStatus } from "../auth/store.js";
import { getTopchesterLogFilePath, getTopchesterSessionsPath } from "../app/paths.js";
import {
  formatModelRef,
  getTopchesterConfigSources,
  loadTopchesterConfig,
  type ConfigLoadOptions,
  type TopchesterConfig,
} from "../config/index.js";
import { getTopchesterVersion } from "../version.js";
import { color, ui } from "./ui.js";

export interface InfoCommandOptions extends ConfigLoadOptions {
  devFlags?: string[];
}

export interface InfoCommandResult {
  ok: boolean;
  lines: string[];
}

export async function collectTopchesterInfo(options: InfoCommandOptions): Promise<InfoCommandResult> {
  const sources = getTopchesterConfigSources(options);
  const lines = [
    color("Topchester info", "cyan"),
    "",
    section("summary"),
    row("version", getTopchesterVersion()),
    row("workspace", formatInfoPath(options.workspaceRoot)),
    "",
    section("config"),
    ...sources.map((source) => {
      if (!source.path) {
        return row(formatConfigSourceLabel(source.label), status("unset", "muted"));
      }

      return row(formatConfigSourceLabel(source.label), `${formatInfoPath(source.path)} ${statusBadge(source.exists)}`);
    }),
  ];

  let config: TopchesterConfig;
  try {
    config = loadTopchesterConfig(options);
  } catch (error) {
    lines.push(row("status", status("invalid", "bad")), row("error", ui.error(formatInfoError(error))));
    return { ok: false, lines };
  }

  lines.push(
    row("status", status("valid", "good")),
    "",
    ...formatModelHints(config),
    "",
    ...formatProviderHints(config, await getAuthStoreStatus())
  );
  lines.push("", ...formatMcpHints(config), "", ...formatHooksHints(config), "", ...formatPathHints(options));

  if (options.devFlags && options.devFlags.length > 0) {
    lines.push("", section("dev"), row("flags", options.devFlags.join(", ")));
  }

  return { ok: true, lines };
}

function formatModelHints(config: TopchesterConfig): string[] {
  const assignments = config.models?.assignments ?? {};
  const purposes = Object.keys(assignments).sort();

  if (purposes.length === 0) {
    return [
      section("models"),
      row("configured", status("none", "muted")),
      row("hint", "run /connect openrouter, then /model"),
    ];
  }

  return [
    section("models"),
    row("default purpose", config.models?.defaultPurpose ?? "agent.primary"),
    ...purposes.map((purpose) =>
      row(purpose, ui.model(formatModelRef(assignments[purpose as keyof typeof assignments]!)))
    ),
  ];
}

function formatProviderHints(config: TopchesterConfig, authStoreStatus: AuthStoreStatus): string[] {
  const providers = config.providers ?? {};
  const namedProviders = Object.entries(providers).filter(([providerId]) => providerId !== "default");

  if (namedProviders.length === 0) {
    return [section("providers"), row("configured", status("none", "muted"))];
  }

  const lines = [section("providers")];

  if (typeof providers.default === "string") {
    lines.push(row("default", providers.default));
  }

  for (const [providerId, provider] of namedProviders) {
    if (typeof provider === "string") {
      continue;
    }

    const auth = formatProviderAuth(providerId, provider, authStoreStatus);

    lines.push(row(providerId, `${provider.type} ${provider.baseURL} auth=${auth}`));
  }

  return lines;
}

function formatProviderAuth(
  providerId: string,
  provider: { apiKeyEnv?: string; apiKey?: string },
  authStoreStatus: AuthStoreStatus
): string {
  if (providerId === "codex") {
    if (authStoreStatus.error) {
      return `oauth ${status("invalid", "bad")}`;
    }

    const providerStatus = authStoreStatus.providers.find((entry) => entry.id === providerId);
    if (!providerStatus) {
      return `oauth ${statusBadge(false)}`;
    }

    if (providerStatus.needsLogin) {
      return `oauth ${status("needs-login", "warn")}`;
    }

    return `oauth ${status(providerStatus.needsRefresh ? "needs-refresh" : "stored", "good")}`;
  }

  return provider.apiKeyEnv
    ? `env:${provider.apiKeyEnv} ${statusBadge(Boolean(process.env[provider.apiKeyEnv]), "set")}`
    : provider.apiKey
      ? status("inline", "good")
      : status("none", "muted");
}

function formatMcpHints(config: TopchesterConfig): string[] {
  const servers = Object.entries(config.mcp ?? {});

  if (servers.length === 0) {
    return [section("mcp"), row("servers", status("none", "muted"))];
  }

  return [
    section("mcp"),
    ...servers.map(([serverName, server]) => {
      const tools =
        server.enabledTools && server.enabledTools.length > 0 ? server.enabledTools.join(",") : "all under cap";
      const commandFound = Boolean(findExecutable(server.command));
      const enabled = server.enabled === false ? status("disabled", "muted") : status("enabled", "good");

      return row(
        serverName,
        `${enabled} command=${server.command} ${statusBadge(commandFound, "found")} tools=${tools}`
      );
    }),
  ];
}

function formatHooksHints(config: TopchesterConfig): string[] {
  const hooks = config.hooks ?? {};
  const hookEntries = Object.entries(hooks).filter(
    (entry): entry is [string, Extract<(typeof entry)[1], unknown[]>] => Array.isArray(entry[1]) && entry[1].length > 0
  );
  const commandCount = hookEntries.reduce((count, [, commands]) => count + commands.length, 0);

  if (commandCount === 0) {
    return [section("hooks"), row("commands", status("none", "muted"))];
  }

  return [section("hooks"), row("events", String(hookEntries.length)), row("commands", String(commandCount))];
}

function formatPathHints(options: InfoCommandOptions): string[] {
  const knowledgePath = join(options.workspaceRoot, "topchester-kb");

  return [
    section("paths"),
    row("sessions", formatInfoPath(getTopchesterSessionsPath(options.workspaceRoot))),
    row("log file", formatInfoPath(getTopchesterLogFilePath(options.workspaceRoot))),
    row("knowledge", `${formatInfoPath(knowledgePath)} ${statusBadge(existsSync(knowledgePath))}`),
  ];
}

function section(title: string): string {
  return color(`${title}:`, "cyan");
}

function row(label: string, value: string): string {
  return `  ${ui.label(label)}: ${value}`;
}

function statusBadge(ok: boolean, okText = "ok"): string {
  return `[${status(ok ? okText : "missing", ok ? "good" : "warn")}]`;
}

function status(text: string, tone: "good" | "warn" | "bad" | "muted"): string {
  switch (tone) {
    case "good":
      return ui.ok(text);
    case "warn":
      return ui.warn(text);
    case "bad":
      return ui.error(text);
    case "muted":
      return ui.muted(text);
  }
}

function formatConfigSourceLabel(label: string): string {
  return label === "env" ? "env TOPCHESTER_CONFIG" : label === "cli" ? "cli --config" : label;
}

function findExecutable(command: string): string | undefined {
  if (command.includes("/") || isAbsolute(command)) {
    return canExecute(command) ? command : undefined;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }

    const candidate = resolve(dir, command);
    if (canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function formatInfoPath(path: string): string {
  const home = homedir();
  const homeRelative = relative(home, path);

  if (!homeRelative) {
    return "~";
  }

  if (!homeRelative.startsWith("..") && !isAbsolute(homeRelative)) {
    return `~/${homeRelative}`;
  }

  return path;
}

function formatInfoError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
