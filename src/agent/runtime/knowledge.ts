import { ui } from "../../cli/ui.js";
import { type L1FileScanStatus } from "../../knowledge/compiler/l1-entry.js";
import { type KnowledgeStatus } from "../../knowledge/status.js";
import { agentEvent, type AgentRuntimeEvent } from "../events.js";
import { parseSlashCommand } from "../commands.js";

/**
 * Applies TUI styling to per-file KB sync states. The raw scanner statuses
 * are preserved as text, but success, warning, and error categories get
 * different colors so slash-command output is readable without changing the
 * underlying command semantics.
 */
export function formatTuiSyncStatus(status: L1FileScanStatus): string {
  if (status === "current") {
    return ui.ok(status);
  }

  if (status === "invalid" || status === "missing_file") {
    return ui.error(status);
  }

  return ui.warn(status);
}

/**
 * Decides whether a slash command should trigger a fresh KB status event.
 * Only KB subcommands that can initialize, sync, reset, or inspect
 * the compiled knowledge state need the refresh; other commands can return
 * their output without doing extra filesystem work.
 */
export function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "reset", "sync", "status"].includes(parsed.args[0] ?? "");
}

/**
 * Converts a computed KB status into the startup event shape consumed by the
 * TUI. The event carries both the structured status and a short next-step
 * message, letting renderers show precise state while keeping user-facing
 * guidance in one place.
 */
export function getKnowledgeStatusEvents(status: KnowledgeStatus): AgentRuntimeEvent[] {
  return [agentEvent.knowledgeStatus(status, formatStartupKnowledgeGuidance(status))];
}

/**
 * Produces the short guidance line shown with startup KB status. The message
 * is deliberately action-oriented: it points to the next command that would
 * fix the current state and returns nothing when the KB is ready and clean.
 */
function formatStartupKnowledgeGuidance(status: KnowledgeStatus): string | undefined {
  if (!status.kbExists) {
    return "Next: run /kb init, then /kb sync to create project knowledge.";
  }

  if (!status.kbIsDirectory) {
    return "Fix the KB path or config, then run /kb status.";
  }

  if (status.kbContentState !== "ready") {
    return "Next: run /kb sync to build project knowledge.";
  }

  if ((status.nonCleanFileCount ?? 0) > 0) {
    return "Next: run /kb sync to update project knowledge, or /kb status to inspect the files.";
  }

  return undefined;
}
