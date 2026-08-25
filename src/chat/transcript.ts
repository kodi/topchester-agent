import { type AgentRuntimeEvent } from "../agent/events.js";
import { type ToolCall } from "../agent/tools.js";
import { type HookEventName } from "../config/index.js";
import { type KnowledgeStatus } from "../knowledge/status.js";

interface SessionTranscriptEntry {
  persistence: "session";
}

interface DisplayTranscriptEntry {
  persistence: "display";
}

export interface SystemTranscriptEntry extends SessionTranscriptEntry {
  kind: "system";
  text: string;
  modelContext?: boolean;
}

export interface UserTranscriptEntry extends SessionTranscriptEntry {
  kind: "user";
  text: string;
  modelContext?: boolean;
}

export interface AssistantTranscriptEntry extends SessionTranscriptEntry {
  kind: "assistant";
  text: string;
  meta?: string;
  modelContext?: boolean;
}

export interface ReasoningTranscriptEntry extends DisplayTranscriptEntry {
  kind: "reasoning";
  text: string;
}

export interface ToolCallTranscriptEntry extends SessionTranscriptEntry {
  kind: "tool_call";
  call: ToolCall;
  label: string;
  resultSummary?: string;
  diff?: string;
}

export interface PersistedHookStatusTranscriptEntry extends SessionTranscriptEntry {
  kind: "hook_status";
  eventName: HookEventName;
  statusMessage: string;
  label: string;
}

export interface DisplayHookStatusTranscriptEntry extends DisplayTranscriptEntry {
  kind: "hook_status";
  label: string;
}

export type HookStatusTranscriptEntry = PersistedHookStatusTranscriptEntry | DisplayHookStatusTranscriptEntry;

export interface ChoiceTranscriptAction {
  label: string;
  value?: string;
}

export interface ChoiceTranscriptEntry extends SessionTranscriptEntry {
  kind: "choice";
  tone: "info" | "warning";
  title: string;
  body?: string;
  actions: ChoiceTranscriptAction[];
}

export interface PermissionAutoApprovedTranscriptEntry extends SessionTranscriptEntry {
  kind: "permission_auto_approved";
  permissionMode: "bash";
  approvalMode: "auto_allow";
  toolName: string;
  command: string;
  workdir: string;
  reason: string;
  label: string;
  toolCallId?: string;
}

export interface PersistedSubagentTranscriptEntry extends SessionTranscriptEntry {
  kind: "subagent";
  status: "running" | "event" | "completed" | "failed";
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  agentProfileId?: string;
  title?: string;
  text?: string;
  event?: AgentRuntimeEvent;
}

export interface DisplaySubagentTranscriptEntry extends DisplayTranscriptEntry {
  kind: "subagent";
  status: "running" | "event" | "completed" | "failed";
  sessionId: string;
  title?: string;
  text?: string;
}

export type SubagentTranscriptEntry = PersistedSubagentTranscriptEntry | DisplaySubagentTranscriptEntry;

export interface KnowledgeStatusTranscriptEntry extends DisplayTranscriptEntry {
  kind: "knowledge_status";
  status: KnowledgeStatus;
  guidance?: string;
}

export interface StartupModelAssignment {
  purpose: string;
  name: string;
  provider?: string;
}

export interface StartupProviderSummary {
  id: string;
  type: string;
  baseURL: string;
  auth: string;
  reasoningEffort?: string;
}

export interface StartupTranscriptEntry extends SessionTranscriptEntry {
  kind: "startup";
  banner?: string;
  workspaceRoot: string;
  defaultModelPurpose: string;
  modelAssignments: StartupModelAssignment[];
  defaultProviderId?: string;
  providers: StartupProviderSummary[];
  setupHint?: string;
  prompt: string;
}

export type PersistedTranscriptEntry =
  | SystemTranscriptEntry
  | UserTranscriptEntry
  | AssistantTranscriptEntry
  | ToolCallTranscriptEntry
  | PersistedHookStatusTranscriptEntry
  | ChoiceTranscriptEntry
  | PermissionAutoApprovedTranscriptEntry
  | PersistedSubagentTranscriptEntry
  | StartupTranscriptEntry;

export type DisplayOnlyTranscriptEntry =
  | ReasoningTranscriptEntry
  | DisplayHookStatusTranscriptEntry
  | DisplaySubagentTranscriptEntry
  | KnowledgeStatusTranscriptEntry;

export type TranscriptEntry = PersistedTranscriptEntry | DisplayOnlyTranscriptEntry;

export function systemTranscriptEntry(text: string, options: { modelContext?: boolean } = {}): SystemTranscriptEntry {
  return { kind: "system", persistence: "session", text, ...options };
}

export function userTranscriptEntry(text: string, options: { modelContext?: boolean } = {}): UserTranscriptEntry {
  return { kind: "user", persistence: "session", text, ...options };
}

export function assistantTranscriptEntry(
  text: string,
  options: { meta?: string; modelContext?: boolean } = {}
): AssistantTranscriptEntry {
  return { kind: "assistant", persistence: "session", text, ...options };
}

export function reasoningTranscriptEntry(text: string): ReasoningTranscriptEntry {
  return { kind: "reasoning", persistence: "display", text };
}

export function isPersistedTranscriptEntry(entry: TranscriptEntry): entry is PersistedTranscriptEntry {
  return entry.persistence === "session";
}

export function parseStartupTranscriptEntry(value: unknown): StartupTranscriptEntry | undefined {
  if (!isRecord(value) || value.kind !== "startup" || value.persistence !== "session") {
    return undefined;
  }

  if (
    typeof value.workspaceRoot !== "string" ||
    typeof value.defaultModelPurpose !== "string" ||
    typeof value.prompt !== "string" ||
    !Array.isArray(value.modelAssignments) ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }

  if (
    !value.modelAssignments.every(
      (assignment) =>
        isRecord(assignment) &&
        typeof assignment.purpose === "string" &&
        typeof assignment.name === "string" &&
        (assignment.provider === undefined || typeof assignment.provider === "string")
    ) ||
    !value.providers.every(
      (provider) =>
        isRecord(provider) &&
        typeof provider.id === "string" &&
        typeof provider.type === "string" &&
        typeof provider.baseURL === "string" &&
        typeof provider.auth === "string" &&
        (provider.reasoningEffort === undefined || typeof provider.reasoningEffort === "string")
    )
  ) {
    return undefined;
  }

  if (
    (value.banner !== undefined && typeof value.banner !== "string") ||
    (value.defaultProviderId !== undefined && typeof value.defaultProviderId !== "string") ||
    (value.setupHint !== undefined && typeof value.setupHint !== "string")
  ) {
    return undefined;
  }

  return value as unknown as StartupTranscriptEntry;
}

export function formatStartupTranscriptText(entry: StartupTranscriptEntry): string {
  const lines = entry.banner ? [entry.banner, ""] : [];
  const assignment = entry.modelAssignments.find(({ purpose }) => purpose === entry.defaultModelPurpose);
  const provider = assignment?.provider ? ` [${assignment.provider}]` : "";
  lines.push(`Model: ${assignment ? `${assignment.name}${provider}` : "not set"}`);
  return lines.join("\n");
}

export function formatStartupKnowledgeStatus(status: KnowledgeStatus): string {
  if (!status.kbExists) return "KB: missing";
  if (!status.kbIsDirectory) return "KB: path conflict";
  if (status.liveSync?.enabled) {
    const active = status.liveSync.queued + (status.liveSync.syncing ? 1 : 0);
    return active > 0 ? `KB: live · ${active} syncing` : `KB: live · ${status.currentEntryCount ?? 0} synced`;
  }
  if (status.kbContentState !== "ready") return "KB: empty";
  if ((status.nonCleanFileCount ?? 0) > 0) {
    return `KB: ready · ${status.nonCleanFileCount} dirty`;
  }
  return "KB: ready";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
