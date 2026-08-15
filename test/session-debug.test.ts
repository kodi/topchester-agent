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
