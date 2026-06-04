import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listAgentMetadata } from "../agent/metadata.js";

const TOPCHESTER_CODEX_BLOCK_START = "# >>> topchester integration: codex";
const TOPCHESTER_CODEX_BLOCK_END = "# <<< topchester integration: codex";

export type IntegrationAction = "installed" | "repaired" | "removed";

export interface IntegrationStatus {
  agent: string;
  displayName: string;
  supported: boolean;
  installed: boolean;
  configPath?: string;
  detail: string;
}

export function listIntegrationStatuses(): IntegrationStatus[] {
  return listAgentMetadata()
    .filter(({ id }) => id !== "topchester")
    .map(({ id, metadata }) => getIntegrationStatus(id, metadata.display_name));
}

export function getIntegrationStatus(agent: string, displayName?: string): IntegrationStatus {
  const normalizedAgent = normalizeAgentId(agent);
  const metadata = listAgentMetadata().find(({ id }) => id === normalizedAgent)?.metadata;
  const name = displayName ?? metadata?.display_name ?? normalizedAgent;

  if (normalizedAgent !== "codex") {
    return {
      agent: normalizedAgent,
      displayName: name,
      supported: false,
      installed: false,
      detail: "not supported yet",
    };
  }

  const configPath = getCodexConfigPath();
  return {
    agent: normalizedAgent,
    displayName: name,
    supported: true,
    installed: false,
    configPath,
    detail: "not installed",
  };
}

export async function getIntegrationStatusAsync(agent: string): Promise<IntegrationStatus> {
  const status = getIntegrationStatus(agent);

  if (status.agent !== "codex" || !status.configPath) {
    return status;
  }

  const contents = await readTextIfExists(status.configPath);
  const installed = contents.includes(TOPCHESTER_CODEX_BLOCK_START) && contents.includes(TOPCHESTER_CODEX_BLOCK_END);

  return {
    ...status,
    installed,
    detail: installed ? "installed" : "not installed",
  };
}

export async function listIntegrationStatusesAsync(agent?: string): Promise<IntegrationStatus[]> {
  if (agent) {
    return [await getIntegrationStatusAsync(agent)];
  }

  const statuses = await Promise.all(
    listIntegrationStatuses().map((status) => getIntegrationStatusAsync(status.agent))
  );
  return statuses;
}

export async function installIntegration(agent: string, action: Exclude<IntegrationAction, "removed"> = "installed") {
  const status = await getIntegrationStatusAsync(agent);
  if (!status.supported || status.agent !== "codex" || !status.configPath) {
    throw new Error(`Unsupported integration: ${agent}`);
  }

  const before = await readTextIfExists(status.configPath);
  const next = appendMarkedBlock(removeMarkedBlock(before), formatCodexIntegrationBlock());
  await mkdir(dirname(status.configPath), { recursive: true });
  await writeFile(status.configPath, next);

  return {
    action,
    status: await getIntegrationStatusAsync(status.agent),
  };
}

export async function removeIntegration(agent: string) {
  const status = await getIntegrationStatusAsync(agent);
  if (!status.supported || status.agent !== "codex" || !status.configPath) {
    throw new Error(`Unsupported integration: ${agent}`);
  }

  const before = await readTextIfExists(status.configPath);
  await mkdir(dirname(status.configPath), { recursive: true });
  await writeFile(status.configPath, ensureTrailingNewline(removeMarkedBlock(before)));

  return {
    action: "removed" as const,
    status: await getIntegrationStatusAsync(status.agent),
  };
}

export function formatIntegrationStatuses(statuses: IntegrationStatus[]): string[] {
  const lines = ["Integrations"];

  for (const status of statuses) {
    const state = status.supported ? (status.installed ? "installed" : "not installed") : "unsupported";
    lines.push(`${status.agent}: ${state}`);
    if (status.configPath) {
      lines.push(`  config: ${status.configPath}`);
    }
    if (!status.supported) {
      lines.push(`  detail: ${status.detail}`);
    }
  }

  return lines;
}

export function formatIntegrationAction(action: IntegrationAction, status: IntegrationStatus): string[] {
  const title =
    action === "installed"
      ? "Integration installed"
      : action === "repaired"
        ? "Integration repaired"
        : "Integration removed";

  return [
    title,
    `agent: ${status.agent}`,
    `state: ${status.installed ? "installed" : "not installed"}`,
    ...(status.configPath ? [`config: ${status.configPath}`] : []),
  ];
}

export async function executeHookStop(agent: string | undefined): Promise<void> {
  const normalizedAgent = normalizeAgentId(agent ?? "");
  if (normalizedAgent !== "codex") {
    throw new Error(agent ? `Unsupported hook agent: ${agent}` : "Usage: topchester hook stop <agent>");
  }
}

function getCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(process.env.HOME || homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function formatCodexIntegrationBlock() {
  return [
    TOPCHESTER_CODEX_BLOCK_START,
    "[[Stop]]",
    "",
    "[[Stop.hooks]]",
    'type = "command"',
    'command = "topchester hook stop codex"',
    "timeout = 10",
    'statusMessage = "Notifying Topchester"',
    TOPCHESTER_CODEX_BLOCK_END,
  ].join("\n");
}

function appendMarkedBlock(contents: string, block: string) {
  const base = contents.trimEnd();
  return `${base ? `${base}\n\n` : ""}${block}\n`;
}

function removeMarkedBlock(contents: string) {
  const start = contents.indexOf(TOPCHESTER_CODEX_BLOCK_START);
  if (start === -1) {
    return contents;
  }

  const end = contents.indexOf(TOPCHESTER_CODEX_BLOCK_END, start);
  if (end === -1) {
    return contents;
  }

  return `${contents.slice(0, start)}${contents.slice(end + TOPCHESTER_CODEX_BLOCK_END.length)}`.trimEnd();
}

async function readTextIfExists(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function ensureTrailingNewline(value: string) {
  return value ? `${value.trimEnd()}\n` : "";
}

function normalizeAgentId(value: string) {
  return value.trim().toLowerCase();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
