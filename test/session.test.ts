import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTopchesterSessionsPath } from "../src/app/paths.js";
import {
  createSession,
  ensureSessionStorage,
  generateSessionId,
  loadSession,
  loadSessionForAppend,
  rehydrateSession,
  resolveLatestSessionId,
} from "../src/session/store.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "topchester-session-"));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("session store", () => {
  it("uses the uuidv7 package for session ID generation", async () => {
    const source = await readFile(join(process.cwd(), "src", "session", "store.ts"), "utf8");

    expect(source).toContain('import { uuidv7 } from "uuidv7";');
    expect(source).not.toContain('from "node:crypto"');
    expect(source).not.toContain("function toUuid");
  });

  it("generates lowercase UUIDv7-style session IDs that sort in creation order", () => {
    const ids = Array.from({ length: 128 }, () => generateSessionId());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))).toBe(
      true
    );
  });

  it("creates project-local metadata and events files", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);

    expect(session.sessionDir).toBe(join(getTopchesterSessionsPath(workspace), session.sessionId));
    await expect(stat(session.metadataPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(stat(session.eventsPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(readFile(session.eventsPath, "utf8")).resolves.toBe("");
    await expect(stat(join(workspace, "topchester-kb"))).rejects.toThrow();

    expect(await readJson(session.metadataPath)).toEqual({
      version: 1,
      sessionId: session.sessionId,
      workspaceRoot: workspace,
      createdAt: session.metadata.createdAt,
      updatedAt: session.metadata.createdAt,
      lastEventId: 0,
    });
  });

  it("initializes only the local session folders without KB side effects", async () => {
    const workspace = await tempWorkspace();

    await ensureSessionStorage(workspace);

    await expect(stat(join(workspace, ".agents"))).resolves.toMatchObject({});
    await expect(stat(join(workspace, ".agents", "topchester"))).resolves.toMatchObject({});
    await expect(stat(join(workspace, ".agents", "topchester", "sessions"))).resolves.toMatchObject({});
    await expect(stat(join(workspace, "topchester-kb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(workspace, ".agents", "topchester-kb-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores global and other-workspace session locations", async () => {
    const workspace = await tempWorkspace();
    const otherWorkspace = await tempWorkspace();
    const fakeHome = await tempWorkspace();
    const fakeConfig = join(fakeHome, ".config", "topchester");
    const otherSession = await createSession(otherWorkspace);
    await otherSession.append({ kind: "message", role: "user", text: "not from this workspace" });
    await mkdir(join(fakeConfig, ".agents", "topchester", "sessions"), { recursive: true });

    const localSession = await createSession(workspace);
    await localSession.append({ kind: "message", role: "user", text: "from this workspace" });

    await expect(resolveLatestSessionId(workspace)).resolves.toBe(localSession.sessionId);
    await expect(loadSession(workspace, otherSession.sessionId)).rejects.toThrow(/Session not found/u);
    await expect(stat(join(fakeHome, ".agents", "topchester", "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fakeConfig, ".agents", "topchester", "sessions"))).resolves.toMatchObject({});
  });

  it("appends newline-terminated JSON objects with sequential IDs and metadata updates", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);

    await session.append({ kind: "message", role: "user", text: "hello", meta: { source: "chat" } });
    const firstMetadata = session.metadata;
    await session.append({ kind: "message", role: "assistant", text: "hi", meta: "model x" });
    const beforeLoad = await readFile(session.eventsPath, "utf8");
    const loaded = await loadSessionForAppend(workspace, session.sessionId);
    await loaded.append({ kind: "status", status: "ready" });

    const raw = await readFile(session.eventsPath, "utf8");
    const lines = raw.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(lines.slice(0, 3).map((line) => JSON.parse(line))).toMatchObject([
      { version: 1, id: 1, kind: "message", role: "user", text: "hello", meta: { source: "chat" } },
      { version: 1, id: 2, kind: "message", role: "assistant", text: "hi", meta: "model x" },
      { version: 1, id: 3, kind: "status", status: "ready" },
    ]);
    expect(raw.startsWith(beforeLoad)).toBe(true);

    const metadata = (await readJson(session.metadataPath)) as { lastEventId: number; updatedAt: string };
    expect(metadata.lastEventId).toBe(3);
    expect(metadata.updatedAt >= firstMetadata.updatedAt).toBe(true);
  });

  it("preserves old JSONL bytes exactly when loading and appending later events", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    await session.append({
      kind: "tool_call",
      label: "Tool custom: keep structured fields",
      call: { tool: "custom", args: { path: "src/index.ts" }, future: { overlayId: "kb-overlay-1" } },
    });
    await session.append({
      kind: "choice",
      tone: "info",
      title: "Choose",
      body: "This old record must not be normalized.",
      actions: [{ label: "Keep", value: "keep" }],
    });
    const originalPrefix = await readFile(session.eventsPath, "utf8");

    const loaded = await loadSessionForAppend(workspace, session.sessionId);
    const appended = await loaded.append({ kind: "status", status: "ready" });
    const afterAppend = await readFile(session.eventsPath, "utf8");

    expect(appended.id).toBe(3);
    expect(afterAppend.startsWith(originalPrefix)).toBe(true);
    expect(afterAppend.slice(0, originalPrefix.length)).toBe(originalPrefix);
    expect(afterAppend.slice(originalPrefix.length).trimEnd()).toEqual(expect.stringContaining('"kind":"status"'));
  });

  it("serializes overlapping appends before assigning event IDs", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);

    const appended = await Promise.all([
      session.append({ kind: "message", role: "user", text: "one" }),
      session.append({ kind: "message", role: "assistant", text: "two" }),
      session.append({ kind: "status", status: "ready" }),
      session.append({ kind: "message", role: "system", text: "four" }),
    ]);

    expect(appended.map((event) => event.id)).toEqual([1, 2, 3, 4]);

    const raw = await readFile(session.eventsPath, "utf8");
    const lines = raw.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("");
    expect(lines.slice(0, 4).map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4]);

    const metadata = (await readJson(session.metadataPath)) as { lastEventId: number; updatedAt: string };
    expect(metadata.lastEventId).toBe(4);
    expect(metadata.updatedAt).toBe(appended.at(-1)!.ts);
  });

  it("continues accepting appends after a queued append fails", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);

    await expect(
      Promise.all([
        session.append({ kind: "message", role: "user", text: "valid" }),
        session.append({ kind: "message", role: "invalid", text: "bad" } as never),
      ])
    ).rejects.toThrow();

    await expect(session.append({ kind: "message", role: "assistant", text: "after failure" })).resolves.toMatchObject({
      id: 2,
      kind: "message",
      text: "after failure",
    });

    const raw = await readFile(session.eventsPath, "utf8");
    expect(
      raw
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).id)
    ).toEqual([1, 2]);
    const metadata = (await readJson(session.metadataPath)) as { lastEventId: number };
    expect(metadata.lastEventId).toBe(2);
  });

  it("keeps event IDs consistent after a metadata write failure", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    const originalMetadata = await readFile(session.metadataPath, "utf8");

    await rm(session.metadataPath);
    await mkdir(session.metadataPath);
    await expect(
      session.append({ kind: "message", role: "user", text: "written before metadata failed" })
    ).rejects.toThrow();

    const rawAfterFailure = await readFile(session.eventsPath, "utf8");
    expect(rawAfterFailure).toMatch(/"id":1/u);
    expect(rawAfterFailure.endsWith("\n")).toBe(true);

    await rm(session.metadataPath, { recursive: true });
    await writeFile(session.metadataPath, originalMetadata);
    await expect(
      session.append({ kind: "message", role: "assistant", text: "after metadata recovered" })
    ).resolves.toMatchObject({
      id: 2,
      text: "after metadata recovered",
    });

    const events = (await readFile(session.eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.id)).toEqual([1, 2]);
    expect((await readJson(session.metadataPath)) as Record<string, unknown>).toMatchObject({ lastEventId: 2 });
  });

  it("preserves structured representative event payloads", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);

    await session.append({
      kind: "tool_call",
      label: "Tool read_file: package.json",
      call: { tool: "read_file", args: { path: "package.json" } },
    });
    await session.append({
      kind: "knowledge_status",
      status: { state: "ready", label: "KB ready", detail: "2 files" },
    });
    await session.append({
      kind: "choice",
      tone: "warning",
      title: "Continue?",
      body: "Pick one",
      actions: [{ label: "Yes", value: "yes" }],
    });

    const events = (await readFile(session.eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      expect.objectContaining({
        version: 1,
        id: 1,
        kind: "tool_call",
        label: "Tool read_file: package.json",
        call: { tool: "read_file", args: { path: "package.json" } },
      }),
      expect.objectContaining({
        version: 1,
        id: 2,
        kind: "knowledge_status",
        status: { state: "ready", label: "KB ready", detail: "2 files" },
      }),
      expect.objectContaining({
        version: 1,
        id: 3,
        kind: "choice",
        tone: "warning",
        title: "Continue?",
        body: "Pick one",
        actions: [{ label: "Yes", value: "yes" }],
      }),
    ]);
  });

  it("creates parent session folders inside the workspace only", async () => {
    const workspace = await tempWorkspace();
    await mkdir(join(workspace, "nested"), { recursive: true });

    const session = await createSession(workspace);

    expect(session.sessionDir.startsWith(join(workspace, ".agents", "topchester", "sessions"))).toBe(true);
  });

  it("strictly loads valid metadata and events", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    await session.append({ kind: "message", role: "user", text: "hello" });
    await session.append({ kind: "message", role: "assistant", text: "hi", meta: "model" });

    const loaded = await loadSession(workspace, session.sessionId);

    expect(loaded.metadata.sessionId).toBe(session.sessionId);
    expect(loaded.events).toMatchObject([
      { id: 1, kind: "message", role: "user", text: "hello" },
      { id: 2, kind: "message", role: "assistant", text: "hi", meta: "model" },
    ]);
  });

  it("rejects malformed JSONL and blank middle lines with line-specific plain errors", async () => {
    const workspace = await tempWorkspace();
    const malformed = await createSession(workspace);
    await writeFile(malformed.eventsPath, '{"version":1\n');
    await expect(loadSession(workspace, malformed.sessionId)).rejects.toThrow(/events\.jsonl line 1/u);
    await expect(loadSession(workspace, malformed.sessionId)).rejects.toThrow(/Could not read session event/u);

    const blank = await createSession(workspace);
    await blank.append({ kind: "message", role: "user", text: "first" });
    await writeFile(
      blank.eventsPath,
      `${JSON.stringify({ version: 1, id: 1, ts: new Date().toISOString(), kind: "message", role: "user", text: "first" })}\n   \n`
    );
    await expect(loadSession(workspace, blank.sessionId)).rejects.toThrow(/events\.jsonl line 2/u);
    await expect(loadSession(workspace, blank.sessionId)).rejects.toThrow(/Blank lines are not allowed/u);
  });

  it("rejects schema and semantic consistency errors plainly", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    await session.append({ kind: "message", role: "user", text: "hello" });

    await writeFile(
      session.eventsPath,
      `${JSON.stringify({ version: 1, id: 1, ts: new Date().toISOString(), kind: "message", role: "bot", text: "bad" })}\n`
    );
    await expect(loadSession(workspace, session.sessionId)).rejects.toThrow(/events\.jsonl line 1/u);
    await expect(loadSession(workspace, session.sessionId)).rejects.toThrow(/role/u);

    await writeFile(
      session.eventsPath,
      `${JSON.stringify({ version: 1, id: 1, ts: new Date().toISOString(), kind: "message", role: "user", text: "ok" })}\n${JSON.stringify(
        {
          version: 1,
          id: 3,
          ts: new Date().toISOString(),
          kind: "message",
          role: "assistant",
          text: "gap",
        }
      )}\n`
    );
    await expect(loadSession(workspace, session.sessionId)).rejects.toThrow(/expected event id 2 but found 3/u);

    const metadata = (await readJson(session.metadataPath)) as Record<string, unknown>;
    await writeFile(
      session.metadataPath,
      `${JSON.stringify({ ...metadata, workspaceRoot: `${workspace}-other` }, null, 2)}\n`
    );
    await expect(loadSession(workspace, session.sessionId)).rejects.toThrow(/metadata\.json workspaceRoot/u);
  });

  it("rejects direct session IDs before paths can escape the session root", async () => {
    const workspace = await tempWorkspace();
    const valid = generateSessionId();
    const invalidIds = [
      "../x",
      "foo/bar",
      join(workspace, valid),
      valid.toUpperCase(),
      "not-a-uuid",
      valid.slice(0, 8),
    ];

    for (const id of invalidIds) {
      await expect(loadSession(workspace, id)).rejects.toThrow(/Session id must be an exact lowercase UUIDv7/u);
    }
  });

  it("resolves latest by metadata updatedAt and falls back to folder order only when needed", async () => {
    const workspace = await tempWorkspace();
    const older = await createSession(workspace);
    const newer = await createSession(workspace);
    await writeFile(
      older.metadataPath,
      `${JSON.stringify({ ...older.metadata, updatedAt: "2025-01-01T00:00:00.000Z" }, null, 2)}\n`
    );
    await writeFile(
      newer.metadataPath,
      `${JSON.stringify({ ...newer.metadata, updatedAt: "2025-01-02T00:00:00.000Z" }, null, 2)}\n`
    );

    await expect(resolveLatestSessionId(workspace)).resolves.toBe(newer.sessionId);

    await writeFile(
      older.metadataPath,
      `${JSON.stringify({ ...older.metadata, updatedAt: older.metadata.createdAt }, null, 2)}\n`
    );
    await writeFile(
      newer.metadataPath,
      `${JSON.stringify({ ...newer.metadata, updatedAt: newer.metadata.createdAt }, null, 2)}\n`
    );
    await expect(resolveLatestSessionId(workspace)).resolves.toBe([older.sessionId, newer.sessionId].sort().at(-1));
  });

  it("does not skip a malformed selected latest candidate", async () => {
    const workspace = await tempWorkspace();
    const older = await createSession(workspace);
    const newer = await createSession(workspace);
    await writeFile(
      older.metadataPath,
      `${JSON.stringify({ ...older.metadata, updatedAt: "2025-01-01T00:00:00.000Z" }, null, 2)}\n`
    );
    await writeFile(
      newer.metadataPath,
      `${JSON.stringify({ ...newer.metadata, updatedAt: "2025-01-02T00:00:00.000Z" }, null, 2)}\n`
    );
    await writeFile(newer.eventsPath, "not json\n");

    await expect(loadSession(workspace, "latest")).rejects.toThrow(newer.sessionId);
    await expect(loadSession(workspace, "latest")).rejects.toThrow(/events\.jsonl line 1/u);
  });

  it("rehydrates persisted visible events without executing old actions", async () => {
    const workspace = await tempWorkspace();
    const session = await createSession(workspace);
    await session.append({ kind: "message", role: "system", text: "startup" });
    await session.append({ kind: "message", role: "user", text: "/help", meta: { inputType: "command" } });
    await session.append({ kind: "message", role: "assistant", text: "answer", meta: "model" });
    await session.append({ kind: "tool_call", label: "Tool shell: echo hi", call: { command: "echo hi" } });
    await session.append({
      kind: "knowledge_status",
      status: { kbPath: "topchester-kb", kbExists: false, kbIsDirectory: false, kbPathSource: "workspace" },
    });
    await session.append({
      kind: "choice",
      tone: "warning",
      title: "Continue?",
      body: "Pick",
      actions: [{ label: "No", value: "no" }],
    });
    await session.append({ kind: "status", status: "ready" });

    const loaded = await loadSession(workspace, session.sessionId);
    const rehydrated = rehydrateSession(loaded.events);

    expect(rehydrated.messages).toEqual([
      { kind: "system", text: "startup" },
      { kind: "user", text: "/help" },
      { kind: "agent", text: "answer", meta: "model" },
      { kind: "system", text: "Tool shell: echo hi" },
      { kind: "system", text: expect.stringContaining("KB status: topchester-kb") },
      { kind: "modal", tone: "warning", title: "Continue?", body: "Pick", actions: [{ label: "No", value: "no" }] },
    ]);
    expect(rehydrated.status).toBe("ready");
  });
});
