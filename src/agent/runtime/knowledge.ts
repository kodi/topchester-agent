import { type L1FileScanStatus } from "../../knowledge/compiler/l1-entry.js";
import { type KnowledgeStatus } from "../../knowledge/status.js";
import { agentEvent, type AgentRuntimeEvent } from "../events.js";
import { parseSlashCommand } from "../commands.js";

/**
 * Keeps per-file KB sync states safe for OpenTUI's plain-text renderer.
 * ANSI sequences embedded in text are counted as cells during layout even
 * though the terminal later hides them, which corrupts aligned rows and wraps.
 */
export function formatTuiSyncStatus(status: L1FileScanStatus): string {
  return status;
}

/**
 * Decides whether a slash command should trigger a fresh KB status event.
 * Only KB subcommands that can initialize, sync, reset, or inspect
 * the compiled knowledge state need the refresh; other commands can return
 * their output without doing extra filesystem work.
 */
export function shouldRefreshKnowledgeStatus(command: string): boolean {
  const parsed = parseSlashCommand(command);

  return parsed?.name === "kb" && ["init", "live", "reset", "sync", "status"].includes(parsed.args[0] ?? "");
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
