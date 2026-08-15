import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { getTopchesterLogFilePath } from "../src/app/paths.js";
import { createSessionDebugReport, formatSessionDebugReport } from "../src/session/debug.js";
import { sessionEventPayload } from "../src/session/events.js";
import { createChildSession, createSession } from "../src/session/store.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "topchester-session-debug-"));
}

describe("session debug report", () => {
  it("reads controller-style enqueued events after an explicit durability barrier", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    const first = session.enqueue({ kind: "message", role: "user", text: "queued prompt" });
    if (first instanceof Promise) await first;
    const second = session.enqueue({ kind: "message", role: "assistant", text: "queued answer" });
    if (second instanceof Promise) await second;

    await session.flush();
    const report = await createSessionDebugReport(workspace, session.sessionId);

    expect(report.events).toMatchObject({ total: 2, userMessages: 1, assistantMessages: 1 });
    await session.dispose();
  });

  it("combines session events, child sessions, and scoped timing records", async () => {
    const workspace = await tempWorkspace();
    const root = await createSession(workspace);
    await root.append({ kind: "message", role: "user", text: "inspect latency" });
    await root.append({
      kind: "tool_call",
      label: "read_file: src/main.ts",
      call: { id: "call-root", tool: "read_file", args: { path: "src/main.ts" }, source: "native" },
    });
    const child = await createChildSession(workspace, {
      parent: root,
      parentToolCallId: "call-task",
      agentProfileId: "explore",
      title: "Inspect runtime",
    });
    await child.append({
      kind: "tool_call",
      label: "grep failed: no matches",
      call: { id: "call-child", tool: "grep", args: { pattern: "missing" }, source: "native" },
    });
    await root.append(
      sessionEventPayload.subagentCompleted({
        sessionId: child.sessionId,
        parentSessionId: root.sessionId,
        parentToolCallId: "call-task",
      })
    );

    const base = Date.now();
    const rootTurn = "turn-root";
    const childTurn = "turn-child";
    const records = [
      log(base, root.sessionId, root.metadata.rootSessionId, rootTurn, { event: "session_turn_started" }),
      log(base + 800, root.sessionId, root.metadata.rootSessionId, rootTurn, {
        event: "model_response",
        modelId: "test/model",
        durationMs: 700,
        modelDurationMs: 600,
      }),
      log(base + 1_100, root.sessionId, root.metadata.rootSessionId, rootTurn, {
        event: "tool_result",
        tool: "read_file",
        toolCallId: "call-root",
        durationMs: 200,
      }),
      log(base + 1_300, root.sessionId, root.metadata.rootSessionId, rootTurn, {
        event: "session_phase",
        category: "setup",
        phase: "prompt_setup",
        durationMs: 100,
      }),
      log(base + 2_000, root.sessionId, root.metadata.rootSessionId, rootTurn, {
        event: "session_turn_finished",
        durationMs: 2_000,
      }),
      log(base + 100, child.sessionId, root.metadata.rootSessionId, childTurn, {
        event: "session_turn_started",
      }),
      log(base + 1_200, child.sessionId, root.metadata.rootSessionId, childTurn, {
        event: "model_response",
        modelId: "test/child",
        durationMs: 1_000,
        modelDurationMs: 1_000,
      }),
      log(base + 1_250, child.sessionId, root.metadata.rootSessionId, childTurn, {
        event: "tool_result",
        tool: "grep",
        toolCallId: "call-child",
        durationMs: 50,
        error: "no matches",
      }),
      log(base + 1_600, child.sessionId, root.metadata.rootSessionId, childTurn, {
        event: "session_turn_finished",
        durationMs: 1_500,
      }),
    ];
    await writeLog(workspace, records);

    const report = await createSessionDebugReport(workspace, root.sessionId.slice(0, 8));

    expect(report.session).toMatchObject({ sessionId: root.sessionId, childSessionCount: 1 });
    expect(report.events).toMatchObject({ toolCalls: 2, failedToolCalls: 1, subagentsCompleted: 1 });
    expect(report.artifacts).toMatchObject({ logExists: true, scopedTimingRecords: records.length });
    expect(report.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "read_file", calls: 1, measuredCalls: 1, measuredWorkMs: 200 }),
        expect.objectContaining({ tool: "grep", calls: 1, failures: 1, measuredCalls: 1, measuredWorkMs: 50 }),
      ])
    );
    expect(report.timing.available).toBe(true);
    expect(report.timing.sessions[0]).toMatchObject({
      sessionId: root.sessionId,
      completedTurns: 1,
      activeTurnMs: 2_000,
      measuredMs: 900,
      coveragePercent: 45,
    });
    expect(report.timing.sessions[0]?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "model", durationMs: 600, percent: 30 }),
        expect.objectContaining({ category: "tool", durationMs: 200, percent: 10 }),
        expect.objectContaining({ category: "setup", durationMs: 100, percent: 5 }),
        expect.objectContaining({ category: "other", durationMs: 1_100, percent: 55 }),
      ])
    );
    expect(report.subagents).toEqual([
      expect.objectContaining({ sessionId: child.sessionId, status: "completed", toolCalls: 1 }),
    ]);
    const text = formatSessionDebugReport(report).join("\n");
    expect(text).toContain("◷ TIMING BREAKDOWN");
    expect(text).toMatch(/██████░░░░░░░░░░░░░░\s+30\.0%/u);
    expect(text).toContain("◇ TOOL CALLS");
    expect(text).toContain("✓ read_file");
    expect(text).toContain("× grep");
    expect(text).toContain("↳ SUBAGENTS");
    expect(text).toContain("✓ completed Inspect runtime");
  });

  it("does not attribute old unscoped log records", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    await session.append({ kind: "message", role: "user", text: "old session" });
    await writeLog(workspace, [
      {
        time: new Date().toISOString(),
        event: "model_response",
        durationMs: 5_000,
        modelId: "legacy/model",
      },
    ]);

    const report = await createSessionDebugReport(workspace, session.sessionId);

    expect(report.artifacts).toMatchObject({ logExists: true, scopedTimingRecords: 0 });
    expect(report.timing.available).toBe(false);
    expect(report.warnings.join(" ")).toContain("Older unscoped entries are not attributed");
  });

  it("keeps every hook run in JSON data and limits text to slow runs plus failures", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    const base = Date.now();
    const turnId = "turn-hooks";
    const successfulRuns = Array.from({ length: 11 }, (_, index) =>
      log(base + 2_000 + index, session.sessionId, session.metadata.rootSessionId, turnId, {
        event: "hook_run",
        hookEventName: "PreToolUse",
        handlerType: "command",
        handlerLabel: "lint-hook.sh",
        handlerOrdinal: 1,
        handlerCount: 1,
        timeoutMs: 5_000,
        durationMs: (index + 1) * 100,
        exitDurationMs: (index + 1) * 100,
        closeWaitMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
      })
    );
    const peonRuns = [
      log(base + 4_000, session.sessionId, session.metadata.rootSessionId, turnId, {
        event: "hook_run",
        hookEventName: "Stop",
        handlerType: "command",
        handlerLabel: "peon.sh",
        handlerOrdinal: 1,
        handlerCount: 3,
        timeoutMs: 5,
        timeoutTriggeredMs: 5,
        durationMs: 10,
        exitDurationMs: 7,
        closeWaitMs: 3,
        exitCode: 0,
        signal: null,
        timedOut: true,
        aborted: false,
      }),
      log(base + 4_001, session.sessionId, session.metadata.rootSessionId, turnId, {
        event: "hook_run",
        hookEventName: "Stop",
        handlerType: "command",
        handlerLabel: "peon.sh",
        handlerOrdinal: 3,
        handlerCount: 3,
        timeoutMs: 5,
        timeoutTriggeredMs: 5,
        durationMs: 9,
        exitDurationMs: 6,
        closeWaitMs: 3,
        exitCode: 0,
        signal: null,
        timedOut: true,
        aborted: false,
      }),
    ];
    await writeLog(workspace, [
      log(base, session.sessionId, session.metadata.rootSessionId, turnId, { event: "session_turn_started" }),
      ...successfulRuns,
      ...peonRuns,
      log(base + 5_000, session.sessionId, session.metadata.rootSessionId, turnId, {
        event: "session_turn_finished",
        durationMs: 5_000,
      }),
    ]);

    const report = await createSessionDebugReport(workspace, session.sessionId);
    const timing = report.timing.sessions[0]!;
    expect(timing.hookRuns).toHaveLength(13);
    expect(timing.hookSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handlerLabel: "lint-hook.sh", runs: 11, failedRuns: 0 }),
        expect.objectContaining({ handlerLabel: "peon.sh", handlerOrdinal: 1, timedOutRuns: 1 }),
        expect.objectContaining({ handlerLabel: "peon.sh", handlerOrdinal: 3, timedOutRuns: 1 }),
      ])
    );
    expect(report.warnings.join(" ")).toContain("ran Stop handler peon.sh 2 times");

    const text = formatSessionDebugReport(report).join("\n");
    expect(text).toContain("🪝 HOOK RUNS");
    expect(text).toContain("Slowest runs (12 of 13; all unsuccessful included)");
    expect(text).toContain("1 faster successful run omitted");
    expect(text).toContain("Stop #1/3 peon.sh");
    expect(text).toContain("timed out at 5ms · process exit at 7ms · 3ms close wait");
  });
});

function log(
  time: number,
  sessionId: string,
  rootSessionId: string,
  turnId: string,
  fields: Record<string, unknown>
): Record<string, unknown> {
  return { level: 20, time: new Date(time).toISOString(), sessionId, rootSessionId, turnId, ...fields };
}

async function writeLog(workspace: string, records: Record<string, unknown>[]): Promise<void> {
  const path = getTopchesterLogFilePath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
