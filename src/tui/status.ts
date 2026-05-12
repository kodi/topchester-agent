import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { type ModelPurpose } from "../model/index.js";
import { colorAsciiBanner, getRandomAsciiBanner } from "./banner.js";
import { renderChatMessage, systemMessage, type ChatMessage } from "./messages.js";

export function getStartupThreadMessages(context: AppContext): ChatMessage[] {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};
  const banner = getRandomAsciiBanner();
  const lines = banner ? ["", "", colorAsciiBanner(banner), "", ""] : [ui.heading("")];

  lines.push(
    `${ui.label("workspace")}: ${context.workspaceRoot}`,
    `${ui.label("default model")}: ${context.config.models?.defaultPurpose ?? "agent.primary"}`
  );

  if (Object.keys(assignments).length === 0) {
    lines.push(`${ui.label("model assignments")}: none configured`);
  } else {
    lines.push(`${ui.label("model assignments")}:`);
    for (const [purpose, model] of Object.entries(assignments)) {
      const provider = model.provider ? ` [${model.provider}]` : "";
      lines.push(`  ${purpose}: ${model.name}${provider}`);
    }
  }

  const namedProviders = Object.entries(providers).filter(([providerId]) => providerId !== "default");

  if (namedProviders.length === 0) {
    lines.push(`${ui.label("providers")}: none configured`);
  } else {
    lines.push(`${ui.label("providers")}:`);
    if (typeof providers.default === "string") {
      lines.push(`  default: ${providers.default}`);
    }
    for (const [providerId, provider] of namedProviders) {
      if (typeof provider === "string") {
        continue;
      }
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      lines.push(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }

  lines.push("");
  lines.push("Ask Topchester what you want to change.");

  return [systemMessage(lines.join("\n"))];
}

export function renderStaticLayout(messages: ChatMessage[], folderName = "", modelLabel = ""): string {
  const threadLines = messages.flatMap((message) => renderChatMessage(message));
  const status = formatStatusLine(folderName, modelLabel);

  return [
    ...threadLines,
    "",
    "┌──────────────────────────────────────────────────────────────────────┐",
    "│ >                                                                    │",
    "└──────────────────────────────────────────────────────────────────────┘",
    status,
  ].join("\n");
}

export function getFolderName(path: string): string {
  return basename(path) || path;
}

export function formatStatusLine(
  folderName: string,
  modelLabel: string,
  status = "ready",
  kbStatus?: string,
  width?: number
): string {
  const folder = folderName ? ` · folder: ${folderName}` : "";
  const model = modelLabel ? ` · ${formatModelStatusSegment(modelLabel)}` : "";
  const left = `${ui.label("status")}: ${status}${folder}${model}`;

  if (!kbStatus) {
    return width === undefined ? left : truncateToWidth(left, width, "…", true);
  }

  if (width === undefined) {
    return `${left} · ${kbStatus}`;
  }

  return formatSplitStatusLine(left, kbStatus, width);
}

function formatSplitStatusLine(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const rightWidth = visibleWidth(right);

  if (rightWidth >= safeWidth) {
    return truncateToWidth(right, safeWidth, "…", true);
  }

  const leftWidth = Math.max(1, safeWidth - rightWidth - 1);
  const leftText = truncateToWidth(left, leftWidth, "…", true);
  const gap = Math.max(1, safeWidth - visibleWidth(leftText) - rightWidth);

  return `${leftText}${" ".repeat(gap)}${right}`;
}

function formatModelStatusSegment(modelLabel: string): string {
  const providerMatch = /^(?<model>.*?)(?<provider> \[[^\]]+\])$/.exec(modelLabel);

  if (!providerMatch?.groups) {
    return ui.model(modelLabel);
  }

  return `${ui.model(providerMatch.groups.model)}${ui.label(providerMatch.groups.provider)}`;
}

export function formatKnowledgeFooterStatus(status: KnowledgeStatus): string {
  if (!status.kbExists) {
    return `${ui.warn("⚠")} kb: ${ui.warn("missing")}`;
  }

  if (!status.kbIsDirectory) {
    return `${ui.error("✕")} kb: ${ui.error("path conflict")}`;
  }

  if (status.kbContentState !== "ready") {
    return `${ui.label("○")} kb: ${ui.label("empty")}`;
  }

  return `${ui.ok("✅")} kb: ${ui.ok("ready")}`;
}

export function formatPathStatus(path: string, exists: boolean, isDirectory: boolean): string {
  if (!exists) {
    return `${path} ${ui.warn("[missing]")}`;
  }

  if (!isDirectory) {
    return `${path} ${ui.error("[not a folder]")}`;
  }

  return `${path} ${ui.ok("[ok]")}`;
}

export function getModelLabel(context: AppContext): string {
  const purpose = context.config.models?.defaultPurpose ?? "agent.primary";
  const model =
    context.config.models?.assignments?.[purpose as ModelPurpose] ?? context.config.models?.assignments?.fallback;

  if (!model) {
    return "not set";
  }

  const provider = model.provider ?? context.config.models?.providers?.default;

  return typeof provider === "string" ? `${model.name} [${provider}]` : model.name;
}
