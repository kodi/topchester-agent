import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { relative } from "node:path";
import { createInterface } from "node:readline";
import { getTopchesterLogFilePath } from "../app/paths.js";
import { type SessionEvent } from "./events.js";
import { listSessionSummaries, loadSessionTree, type LoadedSession, type LoadedSessionTree } from "./store.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_PREFIX_PATTERN = /^[0-9a-f-]{4,35}$/u;
const MAX_GAPS = 10;
const MAX_TEXT_HOOK_ENTRIES = 10;

export type SessionTimingCategory = "model" | "tool" | "subagent" | "hook" | "approval" | "setup" | "other";

export interface SessionDebugReport {
  version: 1;
  generatedAt: string;
  selector: string;
  session: {
    sessionId: string;
    rootSessionId: string;
    source: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
    active: boolean;
    observedSpanMs: number;
    childSessionCount: number;
  };
  artifacts: {
    eventsPath: string;
    logPath: string;
    logExists: boolean;
    logBytes?: number;
    malformedLogLines: number;
    scopedTimingRecords: number;
  };
  events: {
    total: number;
    byKind: Record<string, number>;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    failedToolCalls: number;
    subagentsStarted: number;
    subagentsCompleted: number;
    subagentsFailed: number;
  };
  tools: SessionToolSummary[];
  timing: {
    available: boolean;
    sessions: SessionTimingSummary[];
  };
  subagents: SessionSubagentSummary[];
  longestEventGaps: SessionEventGap[];
  warnings: string[];
}

export interface SessionToolSummary {
  tool: string;
  calls: number;
  failures: number;
  measuredCalls: number;
  measuredWorkMs: number;
  maxMs: number;
}

export interface SessionTimingSummary {
  sessionId: string;
  source: string;
  title?: string;
  completedTurns: number;
  incompleteTurns: number;
  activeTurnMs: number;
  measuredMs: number;
  coveragePercent: number;
  categories: Array<{
    category: SessionTimingCategory;
    durationMs: number;
    percent: number;
    records: number;
  }>;
  models: Array<{
    model: string;
    calls: number;
    durationMs: number;
    maxMs: number;
  }>;
  hookRuns: SessionHookRun[];
  hookSummaries: SessionHookSummary[];
}

export interface SessionHookRun {
  finishedAt: string;
  turnId?: string;
  event: string;
  handlerType: string;
  handlerLabel: string;
  handlerOrdinal?: number;
  handlerCount?: number;
  durationMs: number;
  timeoutMs?: number;
  timeoutTriggeredMs?: number;
  abortTriggeredMs?: number;
  exitDurationMs?: number;
  closeWaitMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  failed: boolean;
}

export interface SessionHookSummary {
  event: string;
  handlerType: string;
  handlerLabel: string;
  handlerOrdinal?: number;
  handlerCount?: number;
  runs: number;
  failedRuns: number;
  timedOutRuns: number;
  abortedRuns: number;
  durationMs: number;
  maxMs: number;
}

export interface SessionSubagentSummary {
  sessionId: string;
  parentSessionId?: string;
  profile?: string;
  title?: string;
  status: "completed" | "failed" | "active" | "unknown";
  observedSpanMs: number;
  events: number;
  toolCalls: number;
}

export interface SessionEventGap {
  durationMs: number;
  from: { id: number; ts: string; kind: string };
  to: { id: number; ts: string; kind: string };
}

export interface SessionDebugTextStyle {
  title(text: string): string;
  section(text: string): string;
  label(text: string): string;
  emphasis(text: string): string;
  accent(text: string): string;
  secondary(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
}

interface LogRecord {
  event?: string;
  time?: string;
  sessionId?: string;
  rootSessionId?: string;
  turnId?: string;
  phase?: string;
  category?: SessionTimingCategory;
  durationMs?: number;
  modelDurationMs?: number;
  tool?: string;
  toolCallId?: string;
  modelId?: string;
  hookEventName?: string;
  handlerType?: string;
  handlerLabel?: string;
  handlerOrdinal?: number;
  handlerCount?: number;
  timeoutMs?: number;
  timeoutTriggeredMs?: number;
  abortTriggeredMs?: number;
  exitDurationMs?: number;
  closeWaitMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  spawnError?: string;
  error?: unknown;
}

interface ParsedLog {
  exists: boolean;
  bytes?: number;
  malformedLines: number;
  records: LogRecord[];
}

interface TimingInterval {
  turnId: string;
  category: Exclude<SessionTimingCategory, "other">;
  startMs: number;
  endMs: number;
}

export async function createSessionDebugReport(workspaceRoot: string, selector: string): Promise<SessionDebugReport> {
  const sessionId = await resolveSessionDebugSelector(workspaceRoot, selector);
  const tree = await loadSessionTree(workspaceRoot, sessionId);
  const sessions = flattenSessionTree(tree);
  const sessionIds = new Set(sessions.map((entry) => entry.sessionId));
  const logPath = getTopchesterLogFilePath(workspaceRoot);
  const parsedLog = await readScopedLogRecords(logPath, sessionIds);
  const allEvents = sessions.flatMap((entry) => entry.events);
  const root = tree.session;
  const now = Date.now();
  const updatedAtMs = Date.parse(root.metadata.updatedAt);
  const lastRootEvent = root.events.at(-1);
  const endedReady = lastRootEvent?.kind === "status" && lastRootEvent.status === "ready";
  const active = !endedReady && Number.isFinite(updatedAtMs) && now - updatedAtMs < 30_000;
  const timingSessions = sessions.map((entry) => buildTimingSummary(entry, parsedLog.records));
  const timingAvailable = timingSessions.some(
    (entry) => entry.completedTurns > 0 || entry.incompleteTurns > 0 || entry.measuredMs > 0
  );
  const toolSummary = buildToolSummary(sessions, parsedLog.records);
  const warnings: string[] = [];

  if (!parsedLog.exists) {
    warnings.push(
      "No debug log exists. Session events provide order and mixed event gaps, but not exact model, tool, hook, or setup time."
    );
  } else if (!timingAvailable) {
    warnings.push(
      "The log has no session-scoped timing records for this session. Older unscoped entries are not attributed because concurrent sessions can be mixed."
    );
  } else {
    for (const summary of timingSessions) {
      if (summary.incompleteTurns > 0) {
        warnings.push(`${shortSessionId(summary.sessionId)} has ${summary.incompleteTurns} incomplete timed turn(s).`);
      }
      if (summary.completedTurns > 0 && summary.coveragePercent < 90) {
        warnings.push(
          `${shortSessionId(summary.sessionId)} has ${formatPercent(summary.coveragePercent)} measured timing coverage; remaining time is reported as other.`
        );
      }
      warnings.push(...buildRepeatedLifecycleHookWarnings(summary));
    }
  }

  if (active) {
    warnings.push("The session changed in the last 30 seconds. This report is a live snapshot and can be incomplete.");
  }

  if (parsedLog.malformedLines > 0) {
    warnings.push(`The log contains ${parsedLog.malformedLines} malformed line(s); valid records were still analyzed.`);
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    selector,
    session: {
      sessionId: root.sessionId,
      rootSessionId: root.metadata.rootSessionId,
      source: root.metadata.source,
      ...(root.metadata.title === undefined ? {} : { title: root.metadata.title }),
      createdAt: root.metadata.createdAt,
      updatedAt: root.metadata.updatedAt,
      active,
      observedSpanMs: durationBetween(root.metadata.createdAt, root.metadata.updatedAt),
      childSessionCount: Math.max(0, sessions.length - 1),
    },
    artifacts: {
      eventsPath: relative(workspaceRoot, `${root.sessionDir}/events.jsonl`),
      logPath: relative(workspaceRoot, logPath),
      logExists: parsedLog.exists,
      ...(parsedLog.bytes === undefined ? {} : { logBytes: parsedLog.bytes }),
      malformedLogLines: parsedLog.malformedLines,
      scopedTimingRecords: parsedLog.records.length,
    },
    events: buildEventSummary(allEvents),
    tools: toolSummary,
    timing: {
      available: timingAvailable,
      sessions: timingSessions,
    },
    subagents: buildSubagentSummary(sessions.slice(1), allEvents),
    longestEventGaps: buildLongestEventGaps(root.events),
    warnings,
  };
}

export function formatSessionDebugReport(
  report: SessionDebugReport,
  style: SessionDebugTextStyle = plainSessionDebugStyle
): string[] {
  const sessionState = report.session.active ? style.warning("● active") : style.success("✓ complete");
  const lines = [
    style.title("Topchester session debug"),
    style.muted("─".repeat(64)),
    "",
    style.section("● SESSION"),
    detailRow("ID", style.emphasis(report.session.sessionId), style),
    detailRow("State", sessionState, style),
    ...(report.session.title ? [detailRow("Title", report.session.title, style)] : []),
    detailRow("Source", report.session.source, style),
    detailRow("Span", formatDuration(report.session.observedSpanMs), style),
    detailRow("Created", report.session.createdAt, style),
    detailRow("Updated", report.session.updatedAt, style),
    detailRow(
      "Activity",
      `${countLabel(report.events.total, "event")} · ${countLabel(report.events.userMessages, "user message")} · ${countLabel(report.events.assistantMessages, "assistant message")} · ${countLabel(report.session.childSessionCount, "child")}`,
      style
    ),
    detailRow("Event mix", formatCounts(report.events.byKind) || "none", style),
    "",
    style.section("◆ ARTIFACTS"),
    artifactRow("events", report.artifacts.eventsPath, true, undefined, style),
    artifactRow(
      "debug log",
      report.artifacts.logPath,
      report.artifacts.logExists,
      report.artifacts.logExists
        ? `${formatBytes(report.artifacts.logBytes ?? 0)} · ${countLabel(report.artifacts.scopedTimingRecords, "timing record")} · ${countLabel(report.artifacts.malformedLogLines, "malformed line")}`
        : "missing",
      style
    ),
    "",
    style.section("◷ TIMING BREAKDOWN"),
  ];

  if (!report.timing.available) {
    lines.push(`  ${style.warning("! Exact timing is unavailable for this session.")}`);
  } else {
    for (const [index, timing] of report.timing.sessions.entries()) {
      const label = timing.source === "user" ? "root" : timing.title ? `child ${timing.title}` : "child";
      if (index > 0) lines.push("");
      lines.push(
        `  ${style.emphasis(label)} ${style.muted(shortSessionId(timing.sessionId))}`,
        `    ${formatDuration(timing.activeTurnMs)} active · ${countLabel(timing.completedTurns, "completed turn")} · ${style.accent(`${formatPercent(timing.coveragePercent)} measured`)}`
      );
      for (const category of timing.categories) {
        const categoryStyle = timingCategoryStyle(category.category, style);
        const recordCount = category.category === "other" ? "untracked" : countLabel(category.records, "record");
        lines.push(
          `    ${categoryStyle(category.category.padEnd(9))} ${timingBar(category.percent, categoryStyle, style)}  ${formatPercent(category.percent).padStart(6)}  ${formatDuration(category.durationMs).padStart(8)}  ${recordCount}`
        );
      }
      if (timing.incompleteTurns > 0) {
        lines.push(`    ${style.warning(`! ${countLabel(timing.incompleteTurns, "incomplete turn")}`)}`);
      }
      if (timing.models.length > 0) {
        lines.push(`    ${style.label("Models")}`);
      }
      for (const model of timing.models) {
        lines.push(
          `      ${style.accent(model.model)} · ${countLabel(model.calls, "call")} · ${formatDuration(model.durationMs)} total · ${formatDuration(model.maxMs)} max`
        );
      }
    }
  }

  lines.push("", style.section("🪝 HOOK RUNS"));
  const hookTimings = report.timing.sessions.filter((timing) => timing.hookRuns.length > 0);
  if (hookTimings.length === 0) {
    lines.push(`  ${style.muted("none")}`);
  } else {
    for (const [index, timing] of hookTimings.entries()) {
      const label = timing.source === "user" ? "root" : timing.title ? `child ${timing.title}` : "child";
      const failedRuns = timing.hookRuns.filter((run) => run.failed).length;
      if (index > 0) lines.push("");
      lines.push(
        `  ${style.emphasis(label)} ${style.muted(shortSessionId(timing.sessionId))}`,
        `    ${countLabel(timing.hookRuns.length, "run")} · ${countLabel(timing.hookSummaries.length, "handler group")} · ${failedRuns > 0 ? style.error(`${failedRuns} unsuccessful`) : style.success("all successful")}`,
        `    ${style.label("Handlers")}`
      );

      const handlerSummaries = selectHookSummariesForText(timing.hookSummaries);
      for (const summary of handlerSummaries) {
        const marker = summary.failedRuns > 0 ? style.error("×") : style.success("✓");
        const outcomes = [
          summary.failedRuns > 0 ? `${summary.failedRuns} unsuccessful` : undefined,
          summary.timedOutRuns > 0 ? `${summary.timedOutRuns} timed out` : undefined,
          summary.abortedRuns > 0 ? `${summary.abortedRuns} aborted` : undefined,
        ].filter((entry): entry is string => entry !== undefined);
        lines.push(
          `      ${marker} ${style.emphasis(formatHookIdentity(summary))} · ${countLabel(summary.runs, "run")} · ${formatDuration(summary.durationMs)} total · ${formatDuration(summary.maxMs)} max${outcomes.length > 0 ? ` · ${style.error(outcomes.join(" · "))}` : ""}`
        );
      }
      if (handlerSummaries.length < timing.hookSummaries.length) {
        const omittedSummaries = timing.hookSummaries.length - handlerSummaries.length;
        lines.push(`      ${style.muted(`${countLabel(omittedSummaries, "successful handler summary")} omitted`)}`);
      }

      const displayedRuns = selectHookRunsForText(timing.hookRuns);
      const omittedRuns = timing.hookRuns.length - displayedRuns.length;
      lines.push(
        `    ${style.label(`Slowest runs (${displayedRuns.length} of ${timing.hookRuns.length}${displayedRuns.length > MAX_TEXT_HOOK_ENTRIES ? "; all unsuccessful included" : ""})`)}`
      );
      for (const run of displayedRuns) {
        const marker = run.failed ? style.error("×") : style.success("✓");
        const outcome = run.failed ? style.error(formatHookOutcome(run)) : style.muted(formatHookOutcome(run));
        lines.push(
          `      ${marker} ${style.emphasis(formatHookIdentity(run))} · ${style.warning(formatDuration(run.durationMs))} · ${outcome}`
        );
      }
      if (omittedRuns > 0) {
        lines.push(`      ${style.muted(`${countLabel(omittedRuns, "faster successful run")} omitted`)}`);
      }
    }
  }

  lines.push("", style.section("◇ TOOL CALLS"));
  if (report.tools.length === 0) {
    lines.push(`  ${style.muted("none")}`);
  } else {
    for (const tool of report.tools) {
      const marker = tool.failures > 0 ? style.error("×") : style.success("✓");
      const failures = tool.failures > 0 ? style.error(`${tool.failures} failed`) : "0 failed";
      const measured =
        tool.measuredCalls > 0
          ? `${formatDuration(tool.measuredWorkMs)} measured · ${formatDuration(tool.maxMs)} max`
          : style.muted("timing unavailable");
      lines.push(
        `  ${marker} ${style.emphasis(tool.tool)}  ${countLabel(tool.calls, "call")} · ${failures} · ${countLabel(tool.measuredCalls, "measured call")} · ${measured}`
      );
    }
  }

  lines.push("", style.section("↳ SUBAGENTS"));
  if (report.subagents.length === 0) {
    lines.push(`  ${style.muted("none")}`);
  } else {
    for (const child of report.subagents) {
      const status = formatSubagentStatus(child.status, style);
      lines.push(
        `  ${status} ${style.emphasis(child.title ?? "untitled")} ${style.muted(shortSessionId(child.sessionId))}`,
        `    ${formatDuration(child.observedSpanMs)} span · ${countLabel(child.events, "event")} · ${countLabel(child.toolCalls, "tool call")}${child.profile ? ` · ${child.profile}` : ""}`
      );
    }
  }

  lines.push("", style.section("⧖ LONGEST MIXED EVENT GAPS"));
  if (report.longestEventGaps.length === 0) {
    lines.push(`  ${style.muted("none")}`);
  } else {
    for (const [index, gap] of report.longestEventGaps.entries()) {
      lines.push(
        `  ${style.label(`${String(index + 1).padStart(2)}.`)} ${style.warning(formatDuration(gap.durationMs).padStart(8))}  #${gap.from.id} ${gap.from.kind} → #${gap.to.id} ${gap.to.kind}`
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", style.section("! NOTES"), ...report.warnings.map((warning) => `  ${style.warning("!")} ${warning}`));
  }

  return lines;
}

function selectHookRunsForText(runs: SessionHookRun[]): SessionHookRun[] {
  const sorted = [...runs].sort(
    (left, right) => right.durationMs - left.durationMs || left.finishedAt.localeCompare(right.finishedAt)
  );
  const selected = new Set(sorted.slice(0, MAX_TEXT_HOOK_ENTRIES));
  for (const run of sorted) {
    if (run.failed) selected.add(run);
  }
  return sorted.filter((run) => selected.has(run));
}

function selectHookSummariesForText(summaries: SessionHookSummary[]): SessionHookSummary[] {
  const selected = new Set(summaries.slice(0, MAX_TEXT_HOOK_ENTRIES));
  for (const summary of summaries) {
    if (summary.failedRuns > 0) selected.add(summary);
  }
  return summaries.filter((summary) => selected.has(summary));
}

function formatHookIdentity(
  hook: Pick<SessionHookRun, "event" | "handlerLabel" | "handlerOrdinal" | "handlerCount">
): string {
  const ordinal =
    hook.handlerOrdinal === undefined
      ? ""
      : ` #${hook.handlerOrdinal}${hook.handlerCount === undefined ? "" : `/${hook.handlerCount}`}`;
  return `${hook.event}${ordinal} ${hook.handlerLabel}`;
}

function formatHookOutcome(run: SessionHookRun): string {
  const parts: string[] = [];

  if (run.spawnError) {
    parts.push("spawn failed");
  } else if (run.timedOut) {
    const timeoutAt = run.timeoutTriggeredMs ?? run.timeoutMs;
    parts.push(timeoutAt === undefined ? "timed out" : `timed out at ${formatDuration(timeoutAt)}`);
  } else if (run.aborted) {
    parts.push(run.abortTriggeredMs === undefined ? "aborted" : `aborted at ${formatDuration(run.abortTriggeredMs)}`);
  } else if (run.exitCode !== undefined || run.signal !== undefined) {
    parts.push(`exit ${run.exitCode ?? run.signal ?? "unknown"}`);
  } else {
    parts.push("completed");
  }

  if (run.exitDurationMs !== undefined && (run.timedOut || run.aborted || (run.closeWaitMs ?? 0) > 0)) {
    parts.push(`process exit at ${formatDuration(run.exitDurationMs)}`);
  }
  if ((run.closeWaitMs ?? 0) > 0) {
    parts.push(`${formatDuration(run.closeWaitMs!)} close wait`);
  }

  return parts.join(" · ");
}

const plainSessionDebugStyle: SessionDebugTextStyle = {
  title: identity,
  section: identity,
  label: identity,
  emphasis: identity,
  accent: identity,
  secondary: identity,
  success: identity,
  warning: identity,
  error: identity,
  muted: identity,
};

function identity(text: string): string {
  return text;
}

function detailRow(label: string, value: string, style: SessionDebugTextStyle): string {
  return `  ${style.label(label.padEnd(10))} ${value}`;
}

function artifactRow(
  label: string,
  path: string,
  exists: boolean,
  detail: string | undefined,
  style: SessionDebugTextStyle
): string {
  const marker = exists ? style.success("✓") : style.error("×");
  const state = detail ? ` ${style.muted(`(${detail})`)}` : "";
  return `  ${marker} ${style.label(label.padEnd(10))} ${path}${state}`;
}

function timingBar(percent: number, filledStyle: (text: string) => string, style: SessionDebugTextStyle): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${filledStyle("█".repeat(filled))}${style.muted("░".repeat(width - filled))}`;
}

function timingCategoryStyle(category: SessionTimingCategory, style: SessionDebugTextStyle): (text: string) => string {
  if (category === "model") return (text) => style.accent(text);
  if (category === "tool") return (text) => style.success(text);
  if (category === "subagent") return (text) => style.secondary(text);
  if (category === "approval") return (text) => style.warning(text);
  if (category === "other") return (text) => style.muted(text);
  return (text) => style.label(text);
}

function formatSubagentStatus(status: SessionSubagentSummary["status"], style: SessionDebugTextStyle): string {
  if (status === "completed") return style.success("✓ completed");
  if (status === "failed") return style.error("× failed");
  if (status === "active") return style.warning("● active");
  return style.muted("? unknown");
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const kibibytes = bytes / 1_024;
  if (kibibytes < 1_024) return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
  const mebibytes = kibibytes / 1_024;
  return `${mebibytes.toFixed(mebibytes < 10 ? 1 : 0)} MiB`;
}

async function resolveSessionDebugSelector(workspaceRoot: string, selector: string): Promise<string> {
  if (selector === "latest" || SESSION_ID_PATTERN.test(selector)) {
    return selector;
  }
  if (!SESSION_PREFIX_PATTERN.test(selector)) {
    throw new Error("Session must be latest, an exact lowercase UUIDv7, or a lowercase session ID prefix.");
  }

  const rootMatches = (await listSessionSummaries(workspaceRoot))
    .map((entry) => entry.sessionId)
    .filter((sessionId) => sessionId.startsWith(selector));

  if (rootMatches.length === 1) {
    return rootMatches[0]!;
  }
  if (rootMatches.length > 1) {
    throw new Error(`Session prefix "${selector}" is ambiguous: ${rootMatches.join(", ")}.`);
  }

  const matches = (await listSessionSummaries(workspaceRoot, { includeSubagents: true }))
    .map((entry) => entry.sessionId)
    .filter((sessionId) => sessionId.startsWith(selector));

  if (matches.length === 0) {
    throw new Error(`No session matches prefix "${selector}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Session prefix "${selector}" is ambiguous: ${matches.join(", ")}.`);
  }
  return matches[0]!;
}

function flattenSessionTree(tree: LoadedSessionTree): LoadedSession[] {
  return [tree.session, ...tree.children.flatMap(flattenSessionTree)];
}

async function readScopedLogRecords(logPath: string, sessionIds: Set<string>): Promise<ParsedLog> {
  try {
    await access(logPath);
  } catch {
    return { exists: false, malformedLines: 0, records: [] };
  }

  const fileStat = await stat(logPath);
  const records: LogRecord[] = [];
  let malformedLines = 0;
  const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line) as LogRecord;
      if (record.sessionId && sessionIds.has(record.sessionId) && isTimingRecord(record)) {
        records.push(record);
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { exists: true, bytes: fileStat.size, malformedLines, records };
}

function isTimingRecord(record: LogRecord): boolean {
  return (
    record.event === "session_turn_started" ||
    record.event === "session_turn_finished" ||
    record.event === "session_phase" ||
    record.event === "model_response" ||
    record.event === "tool_result" ||
    record.event === "hook_run"
  );
}

function buildEventSummary(events: SessionEvent[]): SessionDebugReport["events"] {
  const byKind: Record<string, number> = {};
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  let subagentsStarted = 0;
  let subagentsCompleted = 0;
  let subagentsFailed = 0;

  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.kind === "message" && event.role === "user") userMessages += 1;
    if (event.kind === "message" && event.role === "assistant") assistantMessages += 1;
    if (event.kind === "tool_call") {
      toolCalls += 1;
      if (isFailedToolEvent(event)) failedToolCalls += 1;
    }
    if (event.kind === "subagent_started") subagentsStarted += 1;
    if (event.kind === "subagent_completed") subagentsCompleted += 1;
    if (event.kind === "subagent_failed") subagentsFailed += 1;
  }

  return {
    total: events.length,
    byKind,
    userMessages,
    assistantMessages,
    toolCalls,
    failedToolCalls,
    subagentsStarted,
    subagentsCompleted,
    subagentsFailed,
  };
}

function buildToolSummary(sessions: LoadedSession[], logRecords: LogRecord[]): SessionToolSummary[] {
  const tools = new Map<string, SessionToolSummary>();

  for (const session of sessions) {
    for (const event of session.events) {
      if (event.kind !== "tool_call") continue;
      const tool = typeof event.call.tool === "string" ? event.call.tool : "unknown";
      const summary = tools.get(tool) ?? {
        tool,
        calls: 0,
        failures: 0,
        measuredCalls: 0,
        measuredWorkMs: 0,
        maxMs: 0,
      };
      summary.calls += 1;
      if (isFailedToolEvent(event)) summary.failures += 1;
      tools.set(tool, summary);
    }
  }

  for (const record of logRecords) {
    if (record.event !== "tool_result" || !record.tool || !isFiniteDuration(record.durationMs)) continue;
    const summary = tools.get(record.tool) ?? {
      tool: record.tool,
      calls: 0,
      failures: 0,
      measuredCalls: 0,
      measuredWorkMs: 0,
      maxMs: 0,
    };
    summary.measuredCalls += 1;
    summary.measuredWorkMs += record.durationMs;
    summary.maxMs = Math.max(summary.maxMs, record.durationMs);
    tools.set(record.tool, summary);
  }

  return [...tools.values()].sort(
    (left, right) =>
      right.measuredWorkMs - left.measuredWorkMs || right.calls - left.calls || left.tool.localeCompare(right.tool)
  );
}

function buildTimingSummary(session: LoadedSession, allRecords: LogRecord[]): SessionTimingSummary {
  const records = allRecords.filter((record) => record.sessionId === session.sessionId);
  const startedTurns = new Set(
    records.filter((record) => record.event === "session_turn_started" && record.turnId).map((record) => record.turnId!)
  );
  const finished = records.filter(
    (record) => record.event === "session_turn_finished" && record.turnId && isFiniteDuration(record.durationMs)
  );
  const finishedTurnIds = new Set(finished.map((record) => record.turnId!));
  const activeTurnMs = finished.reduce((sum, record) => sum + record.durationMs!, 0);
  const intervals = records.flatMap(toTimingInterval).filter((interval) => finishedTurnIds.has(interval.turnId));
  const categories: SessionTimingSummary["categories"] = [];
  let measuredMs = 0;

  for (const category of ["model", "tool", "subagent", "hook", "approval", "setup"] as const) {
    const categoryIntervals = intervals.filter((interval) => interval.category === category);
    const durationMs = unionDuration(categoryIntervals);
    if (durationMs === 0 && categoryIntervals.length === 0) continue;
    measuredMs += durationMs;
    categories.push({
      category,
      durationMs,
      percent: percentage(durationMs, activeTurnMs),
      records: categoryIntervals.length,
    });
  }

  const otherMs = Math.max(0, activeTurnMs - measuredMs);
  if (activeTurnMs > 0) {
    categories.push({
      category: "other",
      durationMs: otherMs,
      percent: percentage(otherMs, activeTurnMs),
      records: 0,
    });
  }

  const models = new Map<string, { model: string; calls: number; durationMs: number; maxMs: number }>();
  for (const record of records) {
    const durationMs = record.modelDurationMs ?? record.durationMs;
    if (record.event !== "model_response" || !record.modelId || !isFiniteDuration(durationMs)) continue;
    const model = models.get(record.modelId) ?? { model: record.modelId, calls: 0, durationMs: 0, maxMs: 0 };
    model.calls += 1;
    model.durationMs += durationMs;
    model.maxMs = Math.max(model.maxMs, durationMs);
    models.set(record.modelId, model);
  }
  const hookRuns = buildHookRuns(records);

  return {
    sessionId: session.sessionId,
    source: session.metadata.source,
    ...(session.metadata.title === undefined ? {} : { title: session.metadata.title }),
    completedTurns: finished.length,
    incompleteTurns: [...startedTurns].filter((turnId) => !finishedTurnIds.has(turnId)).length,
    activeTurnMs,
    measuredMs: Math.min(activeTurnMs, measuredMs),
    coveragePercent: percentage(Math.min(activeTurnMs, measuredMs), activeTurnMs),
    categories,
    models: [...models.values()].sort((left, right) => right.durationMs - left.durationMs),
    hookRuns,
    hookSummaries: buildHookSummaries(hookRuns),
  };
}

function buildHookRuns(records: LogRecord[]): SessionHookRun[] {
  return records.flatMap((record) => {
    if (record.event !== "hook_run" || !record.time || !isFiniteDuration(record.durationMs)) return [];
    const failed =
      record.timedOut === true ||
      record.aborted === true ||
      Boolean(record.spawnError) ||
      (record.signal !== undefined && record.signal !== null) ||
      (record.exitCode !== undefined && record.exitCode !== null && record.exitCode !== 0);

    return [
      {
        finishedAt: record.time,
        ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
        event: record.hookEventName ?? "unknown",
        handlerType: record.handlerType ?? "command",
        handlerLabel: record.handlerLabel ?? "command",
        ...(record.handlerOrdinal === undefined ? {} : { handlerOrdinal: record.handlerOrdinal }),
        ...(record.handlerCount === undefined ? {} : { handlerCount: record.handlerCount }),
        durationMs: record.durationMs,
        ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
        ...(record.timeoutTriggeredMs === undefined ? {} : { timeoutTriggeredMs: record.timeoutTriggeredMs }),
        ...(record.abortTriggeredMs === undefined ? {} : { abortTriggeredMs: record.abortTriggeredMs }),
        ...(record.exitDurationMs === undefined ? {} : { exitDurationMs: record.exitDurationMs }),
        ...(record.closeWaitMs === undefined ? {} : { closeWaitMs: record.closeWaitMs }),
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
        ...(record.signal === undefined ? {} : { signal: record.signal }),
        timedOut: record.timedOut === true,
        aborted: record.aborted === true,
        ...(record.spawnError === undefined ? {} : { spawnError: record.spawnError }),
        failed,
      },
    ];
  });
}

function buildHookSummaries(runs: SessionHookRun[]): SessionHookSummary[] {
  const summaries = new Map<string, SessionHookSummary>();

  for (const run of runs) {
    const key = [run.event, run.handlerType, run.handlerOrdinal ?? "", run.handlerLabel].join("\u0000");
    const summary = summaries.get(key) ?? {
      event: run.event,
      handlerType: run.handlerType,
      handlerLabel: run.handlerLabel,
      ...(run.handlerOrdinal === undefined ? {} : { handlerOrdinal: run.handlerOrdinal }),
      ...(run.handlerCount === undefined ? {} : { handlerCount: run.handlerCount }),
      runs: 0,
      failedRuns: 0,
      timedOutRuns: 0,
      abortedRuns: 0,
      durationMs: 0,
      maxMs: 0,
    };
    summary.runs += 1;
    if (run.failed) summary.failedRuns += 1;
    if (run.timedOut) summary.timedOutRuns += 1;
    if (run.aborted) summary.abortedRuns += 1;
    summary.durationMs += run.durationMs;
    summary.maxMs = Math.max(summary.maxMs, run.durationMs);
    summaries.set(key, summary);
  }

  return [...summaries.values()].sort(
    (left, right) =>
      right.durationMs - left.durationMs ||
      left.event.localeCompare(right.event) ||
      (left.handlerOrdinal ?? 0) - (right.handlerOrdinal ?? 0)
  );
}

function buildRepeatedLifecycleHookWarnings(summary: SessionTimingSummary): string[] {
  const lifecycleEvents = new Set(["UserPromptSubmit", "PreCompact", "Stop"]);
  const groups = new Map<string, SessionHookRun[]>();

  for (const run of summary.hookRuns) {
    if (!lifecycleEvents.has(run.event) || run.handlerOrdinal === undefined || run.handlerLabel === "command") continue;
    const occurrence = run.turnId ?? "session";
    const key = [occurrence, run.event, run.handlerLabel].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  return [...groups.values()].flatMap((runs) => {
    if (runs.length < 2) return [];
    const first = runs[0]!;
    return [
      `${shortSessionId(summary.sessionId)} ran ${first.event} handler ${first.handlerLabel} ${runs.length} times in one lifecycle event; inspect duplicate or alias hook configuration.`,
    ];
  });
}

function toTimingInterval(record: LogRecord): TimingInterval[] {
  if (!record.turnId || !record.time) return [];
  const endMs = Date.parse(record.time);
  const durationMs = record.event === "model_response" ? record.modelDurationMs : record.durationMs;
  if (!Number.isFinite(endMs) || !isFiniteDuration(durationMs)) return [];

  let category: Exclude<SessionTimingCategory, "other"> | undefined;
  if (record.event === "model_response") category = "model";
  if (record.event === "tool_result") category = record.tool === "task" ? "subagent" : "tool";
  if (record.event === "hook_run") category = record.hookEventName === "PermissionRequest" ? "approval" : "hook";
  if (record.event === "session_phase" && record.category && record.category !== "other") category = record.category;
  if (!category) return [];

  return [{ turnId: record.turnId, category, startMs: endMs - durationMs, endMs }];
}

function unionDuration(intervals: TimingInterval[]): number {
  const sorted = intervals
    .filter((entry) => entry.endMs >= entry.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;

  for (const interval of sorted) {
    if (start === undefined || end === undefined) {
      start = interval.startMs;
      end = interval.endMs;
    } else if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs);
    } else {
      total += end - start;
      start = interval.startMs;
      end = interval.endMs;
    }
  }

  return start === undefined || end === undefined ? total : total + end - start;
}

function buildSubagentSummary(children: LoadedSession[], rootEvents: SessionEvent[]): SessionSubagentSummary[] {
  const statuses = new Map<string, SessionSubagentSummary["status"]>();
  for (const event of rootEvents) {
    if (event.kind === "subagent_started") statuses.set(event.sessionId, "active");
    if (event.kind === "subagent_completed") statuses.set(event.sessionId, "completed");
    if (event.kind === "subagent_failed") statuses.set(event.sessionId, "failed");
  }

  return children.map((child) => ({
    sessionId: child.sessionId,
    ...(child.metadata.parentSessionId === undefined ? {} : { parentSessionId: child.metadata.parentSessionId }),
    ...(child.metadata.agentProfileId === undefined ? {} : { profile: child.metadata.agentProfileId }),
    ...(child.metadata.title === undefined ? {} : { title: child.metadata.title }),
    status: statuses.get(child.sessionId) ?? inferChildStatus(child),
    observedSpanMs: durationBetween(child.metadata.createdAt, child.metadata.updatedAt),
    events: child.events.length,
    toolCalls: child.events.filter((event) => event.kind === "tool_call").length,
  }));
}

function inferChildStatus(child: LoadedSession): SessionSubagentSummary["status"] {
  return child.events.some((event) => event.kind === "status" && event.status === "ready") ? "completed" : "unknown";
}

function buildLongestEventGaps(events: SessionEvent[]): SessionEventGap[] {
  const gaps: SessionEventGap[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const from = events[index - 1]!;
    const to = events[index]!;
    gaps.push({
      durationMs: durationBetween(from.ts, to.ts),
      from: { id: from.id, ts: from.ts, kind: from.kind },
      to: { id: to.id, ts: to.ts, kind: to.kind },
    });
  }
  return gaps.sort((left, right) => right.durationMs - left.durationMs).slice(0, MAX_GAPS);
}

function isFailedToolEvent(event: Extract<SessionEvent, { kind: "tool_call" }>): boolean {
  return event.label.includes(" failed:") || event.label.includes(" failed ");
}

function durationBetween(start: string, end: string): number {
  const durationMs = Date.parse(end) - Date.parse(start);
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10_000) / 100 : 0;
}

function isFiniteDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
