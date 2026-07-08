import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileMentionProvider } from "../src/tui/file-mention-provider.js";

describe("file mention provider", () => {
  it("indexes workspace files and derived directories", async () => {
    const workspace = await createFixtureWorkspace();
    let updates = 0;
    const provider = createFileMentionProvider({
      workspaceRoot: workspace,
      ttlMs: 1_000,
      onUpdate: () => {
        updates += 1;
      },
    });

    expect(provider.getSuggestions("layout")).toEqual([]);
    await waitFor(() => updates === 1);

    const suggestions = provider.getSuggestions("layout", 5);

    expect(suggestions[0]).toEqual({ path: "src/tui/layout.ts", isDirectory: false });
    expect(provider.getSuggestions("src/tui", 5)).toContainEqual({ path: "src/tui", isDirectory: true });
  });

  it("returns shallow entries first for an empty query", async () => {
    const workspace = await createFixtureWorkspace();
    let updates = 0;
    const provider = createFileMentionProvider({
      workspaceRoot: workspace,
      onUpdate: () => {
        updates += 1;
      },
    });

    provider.getSuggestions("");
    await waitFor(() => updates === 1);

    expect(provider.getSuggestions("", 3)).toEqual([
      { path: "docs", isDirectory: true },
      { path: "src", isDirectory: true },
      { path: "package.json", isDirectory: false },
    ]);
  });

  it("keeps ignored directories out of the index", async () => {
    const workspace = await createFixtureWorkspace();
    let updates = 0;
    const provider = createFileMentionProvider({
      workspaceRoot: workspace,
      onUpdate: () => {
        updates += 1;
      },
    });

    provider.getSuggestions("ignored");
    await waitFor(() => updates === 1);

    expect(provider.getSuggestions("ignored")).toEqual([]);
    expect(provider.getSuggestions("topchester-kb")).toEqual([]);
  });

  it("serves from cache without firing another update before ttl expires", async () => {
    const workspace = await createFixtureWorkspace();
    let updates = 0;
    const provider = createFileMentionProvider({
      workspaceRoot: workspace,
      ttlMs: 60_000,
      onUpdate: () => {
        updates += 1;
      },
    });

    provider.getSuggestions("layout");
    provider.getSuggestions("layout");
    await waitFor(() => updates === 1);

    provider.getSuggestions("guide");

    expect(updates).toBe(1);
  });
});

async function createFixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-file-mentions-"));

  await mkdir(join(workspace, "src", "tui"), { recursive: true });
  await mkdir(join(workspace, "src", "agent", "deep"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(workspace, "node_modules", "ignored"), { recursive: true });
  await mkdir(join(workspace, "topchester-kb", "l1-files"), { recursive: true });
  await writeFile(join(workspace, "src", "tui", "layout.ts"), "");
  await writeFile(join(workspace, "src", "agent", "deep", "layout-helper.ts"), "");
  await writeFile(join(workspace, "docs", "guide.md"), "");
  await writeFile(join(workspace, "package.json"), "{}");
  await writeFile(join(workspace, "node_modules", "ignored", "ignored-layout.ts"), "");
  await writeFile(join(workspace, "topchester-kb", "l1-files", "ignored.json"), "");

  return workspace;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Timed out waiting for provider refresh.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
