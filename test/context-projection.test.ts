import { describe, expect, it } from "vite-plus/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationTurnsToProjection,
  projectionToConversationTurns,
  validateProjection,
} from "../src/agent/context/projection.js";
import { buildConversationPrompt } from "../src/agent/conversation.js";
import { createSession, loadSession, rehydrateSession } from "../src/session/store.js";

describe("replayable model projections", () => {
  it("round trips inline turns and keeps the summary separate", () => {
    const projection = conversationTurnsToProjection([
      { role: "user", text: "new request" },
      { role: "assistant", text: "working" },
    ]);
    projection.summary = "Goal\nPreserve ABC-123.";
    expect(projectionToConversationTurns(projection, [])).toEqual([
      { role: "assistant", text: "[Compacted context]\nGoal\nPreserve ABC-123." },
      { role: "user", text: "new request" },
      { role: "assistant", text: "working" },
    ]);
  });

  it("replays retained knowledge before compacted conversation with the original prompt boundary", () => {
    const turns = projectionToConversationTurns(
      {
        version: 1,
        summary: "Goal\nContinue the task.",
        segments: [
          { kind: "inline", segmentKind: "knowledge", text: "Knowledge pack\n\nConversation:" },
          { kind: "inline", segmentKind: "turn", role: "user", text: "recent request" },
        ],
      },
      []
    );
    expect(buildConversationPrompt(turns, "recent request")).toBe(
      "Knowledge pack\n\nConversation:\nAssistant: [Compacted context]\nGoal\nContinue the task.\n\nUser: recent request"
    );
  });

  it("fails closed for missing transcript references and unmatched tool continuation state", () => {
    expect(() => validateProjection({ version: 1, segments: [{ kind: "transcript_ref", eventId: 9 }] }, [])).toThrow(
      "missing transcript event 9"
    );
    expect(() =>
      validateProjection(
        {
          version: 1,
          segments: [{ kind: "inline", segmentKind: "tool_result", text: "ok", toolAssociationId: "call-1" }],
        },
        []
      )
    ).toThrow("result without continuation state");
    expect(() =>
      validateProjection(
        {
          version: 1,
          segments: [{ kind: "inline", segmentKind: "tool_result", text: "ok" }],
        },
        []
      )
    ).toThrow("without an association id");
    expect(() =>
      validateProjection(
        {
          version: 1,
          segments: [
            { kind: "inline", segmentKind: "continuation", text: "continue", toolAssociationId: "call-1" },
            { kind: "inline", segmentKind: "tool_result", text: "ok", toolAssociationId: "call-1" },
          ],
        },
        []
      )
    ).toThrow("continuation state before its result");
    expect(() =>
      validateProjection(
        {
          version: 1,
          segments: [{ kind: "inline", segmentKind: "turn", text: "missing role" }],
        },
        []
      )
    ).toThrow("turn without a role");
  });

  it("persists the authoritative projection separately from the complete visible transcript", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-context-projection-"));
    const session = await createSession(workspace);
    await session.append({ kind: "message", role: "user", text: "old user" });
    await session.append({ kind: "message", role: "assistant", text: "old assistant" });
    await session.append({ kind: "tool_call", label: "read src/app.ts", call: { tool: "read_file", args: {} } });
    const route = { providerId: "proxy", baseURL: "https://proxy.test/v1", modelId: "model" };
    const capacity = { contextWindow: 32_000, source: "config" as const, confidence: "authoritative" as const };
    const usage = {
      promptTokens: 4_000,
      trailingEstimatedTokens: 0,
      source: "local-estimate" as const,
      estimated: true,
      route,
      asOfModelCall: 1,
      requestBaseFingerprint: "fingerprint",
      observedAt: "2026-08-26T00:00:00.000Z",
    };
    const status = {
      route,
      usage,
      budget: {
        capacity,
        usedTokens: 4_000,
        hardPromptBudget: 24_000,
        compactAtTokens: 18_000,
        targetTokens: 9_000,
        uncertaintyTokens: 2_000,
      },
      compactionsThisSession: 1,
      compactionsThisTurn: 1,
    };
    const projection = {
      version: 1 as const,
      summary: "Goal\nKeep exact path src/app.ts.",
      segments: [
        { kind: "transcript_ref" as const, eventId: 2 },
        {
          kind: "inline" as const,
          segmentKind: "tool_result" as const,
          text: "[read_file src/app.ts: completed; output pruned]",
          toolAssociationId: "call-1",
        },
        {
          kind: "inline" as const,
          segmentKind: "continuation" as const,
          text: "Continue after call-1.",
          toolAssociationId: "call-1",
        },
      ],
    };
    await session.append({
      kind: "context_compaction",
      projectionVersion: 1,
      reason: "manual",
      projection,
      beforeTokens: 9_000,
      afterEstimatedTokens: 4_000,
      route,
      capacity,
      status,
    });
    await session.append({ kind: "message", role: "user", text: "new user" });

    const rehydrated = rehydrateSession((await loadSession(workspace, session.sessionId)).events);
    expect(rehydrated.transcript.some((entry) => entry.kind === "tool_call")).toBe(true);
    expect(rehydrated.modelProjection).toEqual(projection);
    expect(rehydrated.modelContextTurns).toEqual([
      { role: "assistant", text: "[Compacted context]\nGoal\nKeep exact path src/app.ts." },
      { role: "assistant", text: "old assistant" },
      {
        role: "user",
        text: "[Retained active-turn continuation]\n[read_file src/app.ts: completed; output pruned]\n\nContinue after call-1.",
      },
      { role: "user", text: "new user" },
    ]);
    expect(rehydrated.contextStatus).toEqual(status);
  });

  it("drops retained active-turn continuation state once the final assistant turn is durable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-context-projection-final-"));
    const session = await createSession(workspace);
    const route = { providerId: "proxy", baseURL: "https://proxy.test/v1", modelId: "model" };
    const capacity = { contextWindow: 32_000, source: "config" as const, confidence: "authoritative" as const };
    const status = {
      route,
      usage: {
        promptTokens: 4_000,
        trailingEstimatedTokens: 0,
        source: "local-estimate" as const,
        estimated: true,
        route,
        asOfModelCall: 1,
        requestBaseFingerprint: "fingerprint",
        observedAt: "2026-08-26T00:00:00.000Z",
      },
      budget: { capacity, usedTokens: 4_000, uncertaintyTokens: 2_000 },
      compactionsThisSession: 1,
      compactionsThisTurn: 1,
    };
    await session.append({
      kind: "context_compaction",
      projectionVersion: 1,
      reason: "threshold",
      projection: {
        version: 1,
        summary: "Working state.",
        segments: [
          { kind: "inline", segmentKind: "tool_result", text: "tool output", toolAssociationId: "call-1" },
          { kind: "inline", segmentKind: "continuation", text: "continue", toolAssociationId: "call-1" },
        ],
      },
      beforeTokens: 9_000,
      afterEstimatedTokens: 4_000,
      route,
      capacity,
      status,
    });
    await session.append({ kind: "message", role: "assistant", text: "finished" });

    const rehydrated = rehydrateSession((await loadSession(workspace, session.sessionId)).events);
    expect(rehydrated.modelContextTurns).toEqual([
      { role: "assistant", text: "[Compacted context]\nWorking state." },
      { role: "assistant", text: "finished" },
    ]);
  });
});
