import { basename } from "node:path";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { type ModelPurpose } from "../model/index.js";
import { renderChatMessage, systemMessage, type ChatMessage } from "./messages.js";

export function getStartupThreadMessages(context: AppContext): ChatMessage[] {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};
  const lines = [
    ui.heading(""),
    `${ui.label("workspace")}: ${context.workspaceRoot}`,
    `${ui.label("default model")}: ${context.config.models?.defaultPurpose ?? "agent.primary"}`,
  ];

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

  return lines.map(systemMessage);
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

export function formatStatusLine(folderName: string, modelLabel: string, status = "ready"): string {
  const folder = folderName ? ` · folder: ${folderName}` : "";
  const model = modelLabel ? ` · model: ${modelLabel}` : "";

  return `${ui.label("status")}: ${status}${folder}${model}`;
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
