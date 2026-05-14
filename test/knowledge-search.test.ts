import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildL1InMemoryIndex, createL1ContextPack, searchL1Knowledge } from "../src/knowledge/search.js";
import { getL1FileEntryPath } from "../src/knowledge/compiler/path-encoding.js";
import { initializeKnowledgeBase } from "../src/knowledge/init.js";
import { type L1FileEntry } from "../src/knowledge/compiler/l1-entry.js";

describe("L1 in-memory knowledge search", () => {
  it("ranks symbol matches above broad summary matches", () => {
    const index = buildL1InMemoryIndex([
      createEntry("src/posts/post-service.ts", {
        summary: "Handles CMS content persistence.",
        symbols: ["updatePostAuthor"],
        exports: ["updatePostAuthor"],
        responsibilities: ["Update the author assigned to a post."],
      }),
      createEntry("src/logging/error-log.ts", {
        summary: "Formats update errors for user-visible logs.",
        responsibilities: ["Render error output."],
      }),
    ]);

    const matches = index.search("error log when user tries to update author of a post");

    expect(matches[0]?.path).toBe("src/posts/post-service.ts");
    expect(matches[0]?.reasons).toContain("symbol matched update");
    expect(matches[0]?.contentHash).toMatch(/^sha256:/);
  });

  it("splits camelCase query terms and symbols", () => {
    const index = buildL1InMemoryIndex([
      createEntry("src/cms/posts.ts", {
        summary: "CMS post operations.",
        symbols: ["updatePostAuthor"],
      }),
    ]);

    const matches = index.search("updatePostAuthor");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.reasons).toEqual(
      expect.arrayContaining(["symbol matched update", "symbol matched post", "symbol matched author"])
    );
  });

  it("loads canonical L1 entries from the configured KB folder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-search-"));
    await initializeKnowledgeBase(workspace);
    const entry = createEntry("src/posts/post-service.ts", {
      summary: "Updates CMS posts and post authors.",
      symbols: ["updatePostAuthor"],
      exports: ["updatePostAuthor"],
    });
    const entryPath = getL1FileEntryPath(join(workspace, "topchester-kb"), entry.path);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    const result = await searchL1Knowledge(workspace, "post author update");

    expect(result.entryCount).toBe(1);
    expect(result.invalidEntryCount).toBe(0);
    expect(result.matches.map((match) => match.path)).toEqual(["src/posts/post-service.ts"]);
  });

  it("creates compact context packs for strong matches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-search-"));
    await initializeKnowledgeBase(workspace);
    const entry = createEntry("src/tui/status.ts", {
      summary: "Renders the TUI status bar.",
      responsibilities: ["Show status bar details."],
      symbols: ["renderStatusBar"],
      exports: ["renderStatusBar"],
    });
    const entryPath = getL1FileEntryPath(join(workspace, "topchester-kb"), entry.path);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    const result = await createL1ContextPack(workspace, "status bar", { limit: 3, minScore: 10 });

    expect(result.selection).toEqual({ limit: 3, minScore: 10 });
    expect(result.drift.status).toBe("unchecked");
    expect(result.relevantFiles).toHaveLength(1);
    expect(result.relevantFiles[0]?.path).toBe("src/tui/status.ts");
    expect(result.relevantFiles[0]?.l1).toMatchObject({
      summary: "Renders the TUI status bar.",
      responsibilities: ["Show status bar details."],
      symbols: [{ kind: "function", name: "renderStatusBar", exported: true }],
    });
    expect(result.relevantFiles[0]?.l1).not.toHaveProperty("omitted");
    expect(result.relevantFiles[0]?.fullL1).toBeUndefined();
  });

  it("can include full L1 entries when explicitly requested", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-search-"));
    await initializeKnowledgeBase(workspace);
    const entry = createEntry("src/tui/status.ts", {
      summary: "Renders the TUI status bar.",
      responsibilities: ["Show status bar details."],
      symbols: ["renderStatusBar"],
      exports: ["renderStatusBar"],
    });
    const entryPath = getL1FileEntryPath(join(workspace, "topchester-kb"), entry.path);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    const result = await createL1ContextPack(workspace, "status bar", {
      limit: 3,
      minScore: 10,
      includeFullL1: true,
    });

    expect(result.relevantFiles[0]?.fullL1).toEqual(entry);
  });

  it("clips generic symbol summaries from compact context packs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-search-"));
    await initializeKnowledgeBase(workspace);
    const entry = createEntry("src/knowledge/progress.ts", {
      summary: "Reports knowledge progress status.",
      responsibilities: ["Report status bar progress."],
      symbols: ["KnowledgeProgressEvent"],
      exports: ["KnowledgeProgressEvent"],
    });
    entry.symbols[0]!.kind = "symbol";
    const entryPath = getL1FileEntryPath(join(workspace, "topchester-kb"), entry.path);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);

    const result = await createL1ContextPack(workspace, "progress status", { limit: 3, minScore: 10 });

    expect(result.relevantFiles[0]?.l1.symbols?.[0]).toEqual({
      name: "KnowledgeProgressEvent",
      exported: true,
    });
  });
});

function createEntry(
  path: string,
  fields: {
    summary: string;
    responsibilities?: string[];
    symbols?: string[];
    exports?: string[];
  }
): L1FileEntry {
  return {
    $schema: "../schema/file-entry.v1.json",
    id: `file:${path}`,
    layer: "L1",
    type: "file",
    path,
    language: "typescript",
    content_hash: `sha256:${"a".repeat(64)}`,
    size_bytes: 123,
    last_scanned_at: "2026-05-14T00:00:00Z",
    scan_status: "current",
    file_role: "unknown",
    summary: fields.summary,
    responsibilities: fields.responsibilities ?? ["Support CMS post author updates."],
    symbols: (fields.symbols ?? []).map((name) => ({
      id: `symbol:${path}#${name}`,
      kind: "function",
      name,
      exported: true,
      summary: name === "KnowledgeProgressEvent" ? `Symbol named ${name}.` : `${name} handles CMS behavior.`,
    })),
    imports: [],
    exports: fields.exports ?? [],
    module_ids: [],
    feature_ids: [],
    test_ids: [],
    declared_test_targets: [],
    likely_test_targets: [],
    tested_by: [],
    evidence: [{ kind: "path", value: path }],
    confidence: "medium",
  };
}
