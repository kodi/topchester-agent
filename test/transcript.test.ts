import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { agentEvent } from "../src/agent/events.js";
import {
  assistantTranscriptEntry,
  createStartupTranscriptEntry,
  formatStartupKnowledgeStatus,
  formatStartupTranscriptText,
  reasoningTranscriptEntry,
  runtimeEventToTranscriptEntries,
  systemTranscriptEntry,
  userTranscriptEntry,
  type TranscriptEntry,
} from "../src/chat/index.js";
import { createSession, loadSession, rehydrateSession } from "../src/session/store.js";
import { transcriptEntryToSessionPayload } from "../src/session/transcript-payloads.js";
import { createTestContext } from "./app-context.fixtures.js";

const subagentReference = {
  sessionId: "child-session",
  parentSessionId: "parent-session",
  parentToolCallId: "tool-call-1",
} as const;

const knowledgeStatus = {
  workspaceRoot: "/repo",
  kbPath: "/repo/topchester-kb",
  cachePath: "/repo/.agents/topchester-kb-cache",
  kbExists: false,
  kbIsDirectory: false,
  cacheExists: false,
  cacheIsDirectory: false,
  kbPathSource: "default" as const,
  cachePathSource: "default" as const,
};

function createTranscriptVariants(): TranscriptEntry[] {
  return [
    systemTranscriptEntry("system"),
    userTranscriptEntry("user"),
    assistantTranscriptEntry("assistant", { meta: "model" }),
    createStartupTranscriptEntry(createTestContext("/repo"), { banner: "TOPCHESTER" }),
    {
      kind: "tool_call",
      persistence: "session",
      call: { tool: "read_file", args: { path: "README.md" } },
      label: "read_file: README.md",
      diff: "--- old\n+++ new",
    },
    {
      kind: "hook_status",
      persistence: "session",
      eventName: "PreToolUse",
      statusMessage: "Checking",
      label: "hook>pre-tool-use: Checking",
    },
    {
      kind: "choice",
      persistence: "session",
      tone: "warning",
      title: "Continue?",
      actions: [{ label: "Continue", value: "continue" }],
    },
    {
      kind: "permission_auto_approved",
      persistence: "session",
      permissionMode: "bash",
      approvalMode: "auto_allow",
      toolName: "bash",
      command: "pwd",
      workdir: "/repo",
      reason: "benchmark mode",
      label: "auto-approved bash permission: pwd",
    },
    { kind: "subagent", persistence: "session", status: "running", ...subagentReference, title: "Inspect" },
    {
      kind: "subagent",
      persistence: "session",
      status: "event",
      ...subagentReference,
      text: "read_file: README.md",
      event: agentEvent.toolCall({ tool: "read_file", args: { path: "README.md" } }, "read_file: README.md"),
    },
    { kind: "subagent", persistence: "session", status: "completed", ...subagentReference, text: "Done" },
    { kind: "subagent", persistence: "session", status: "failed", ...subagentReference, text: "Failed" },
    reasoningTranscriptEntry("thinking"),
    { kind: "hook_status", persistence: "display", label: "transient hook" },
    { kind: "subagent", persistence: "display", status: "event", sessionId: "child-session", text: "working" },
    { kind: "knowledge_status", persistence: "display", status: knowledgeStatus, guidance: "Run /kb init" },
  ];
}

describe("renderer-neutral transcript", () => {
  it("formats startup as logo plus the active model only", () => {
    const entry = createStartupTranscriptEntry(
      {
        ...createTestContext("/repo"),
        config: {
          models: {
            defaultPurpose: "agent.primary",
            assignments: {
              "agent.primary": { name: "gpt-5.6-sol(medium)", provider: "openai" },
              "fallback": { name: "fallback-model", provider: "openai" },
            },
          },
        },
      },
      { banner: "TOPCHESTER" }
    );

    expect(formatStartupTranscriptText(entry)).toBe("TOPCHESTER\n\nModel: gpt-5.6-sol(medium) [openai]");
  });

  it("formats compact KB startup states", () => {
    expect(formatStartupKnowledgeStatus(knowledgeStatus)).toBe("KB: missing");
    expect(
      formatStartupKnowledgeStatus({
        ...knowledgeStatus,
        kbExists: true,
        kbIsDirectory: true,
        kbContentState: "ready",
        nonCleanFileCount: 2,
      })
    ).toBe("KB: ready · 2 dirty");
    expect(
      formatStartupKnowledgeStatus({
        ...knowledgeStatus,
        kbExists: true,
        kbIsDirectory: true,
        kbContentState: "ready",
        currentEntryCount: 1,
        liveSync: { enabled: true, queued: 1, syncing: true, syncingPath: "src/index.ts" },
      })
    ).toBe("KB: live · 2 syncing");
    expect(
      formatStartupKnowledgeStatus({
        ...knowledgeStatus,
        kbExists: true,
        kbIsDirectory: true,
        kbContentState: "ready",
        currentEntryCount: 1,
        liveSync: { enabled: true, queued: 0, syncing: false },
      })
    ).toBe("KB: live · 1 synced");
  });

  it("maps persisted variants to session payloads and excludes display-only variants", () => {
    const variants = createTranscriptVariants();
    const displayOnly = variants.filter((entry) => entry.persistence === "display");
    const persisted = variants.filter((entry) => entry.persistence === "session");

    expect(displayOnly.map(transcriptEntryToSessionPayload)).toEqual([undefined, undefined, undefined, undefined]);
    expect(persisted.map(transcriptEntryToSessionPayload).map((payload) => payload?.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
      "tool_call",
      "hook_status",
      "choice",
      "permission_auto_approved",
      "subagent_started",
      "subagent_event",
      "subagent_completed",
      "subagent_failed",
    ]);
  });

  it("round-trips structured startup data through session storage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-transcript-startup-"));
    const entry = createStartupTranscriptEntry(createTestContext(workspace), { banner: "TOPCHESTER" });
    const payload = transcriptEntryToSessionPayload(entry);
    const session = await createSession(workspace);

    if (!payload) {
      throw new Error("Startup transcript must be persistable.");
    }

    await session.append(payload);
    const rehydrated = rehydrateSession((await loadSession(workspace, session.sessionId)).events);

    expect(rehydrated.transcript).toEqual([entry]);
  });

  it("reduces runtime events to semantic entries without renderer imports", () => {
    expect(runtimeEventToTranscriptEntries(agentEvent.assistantMessage("Done", "model"))).toEqual([
      assistantTranscriptEntry("Done", { meta: "model" }),
    ]);
    expect(runtimeEventToTranscriptEntries(agentEvent.knowledgeStatus(knowledgeStatus, "Run /kb init"))).toEqual([
      { kind: "knowledge_status", persistence: "display", status: knowledgeStatus, guidance: "Run /kb init" },
    ]);
    expect(
      runtimeEventToTranscriptEntries(agentEvent.subagentCompleted({ ...subagentReference, result: "Child result" }))
    ).toEqual([
      {
        kind: "subagent",
        persistence: "session",
        status: "completed",
        ...subagentReference,
        text: "Child result",
      },
    ]);
    expect(runtimeEventToTranscriptEntries(agentEvent.status("ready"))).toEqual([]);
    expect(
      runtimeEventToTranscriptEntries(agentEvent.taskPlan({ updatedAt: "2026-07-17T00:00:00.000Z", items: [] }))
    ).toEqual([]);
  });
});
