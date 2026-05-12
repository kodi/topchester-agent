import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTopchesterSessionsPath } from "../src/app/paths.js";
import { createSession, generateSessionId, loadSessionForAppend } from "../src/session/store.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "topchester-session-"));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("session store", () => {
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
});
