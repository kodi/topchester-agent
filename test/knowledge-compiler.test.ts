import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileKnowledgeBase } from "../src/knowledge/compiler/index.js";
import { listProjectFilesForL1 } from "../src/knowledge/compiler/inventory.js";
import { initializeKnowledgeBase } from "../src/knowledge/init.js";

const envKeys = ["TOPCHESTER_KB_DIR", "TOPCHESTER_KB_CACHE_DIR"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("knowledge compiler inventory", () => {
  it("reads root and nested gitignore files before queueing L1 files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-"));
    await mkdir(join(workspace, "src", "generated"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "node_modules/\ndist/\n*.log\n");
    await writeFile(join(workspace, "src", ".gitignore"), "generated/\n");
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(workspace, "src", "debug.log"), "ignored\n");
    await writeFile(join(workspace, "src", "generated", "client.ts"), "ignored\n");
    await writeFile(join(workspace, "docs", "guide.md"), "# Guide\n");

    const inventory = await listProjectFilesForL1(workspace);

    expect(inventory.gitignoreFiles).toEqual([join(workspace, ".gitignore"), join(workspace, "src", ".gitignore")]);
    expect(inventory.files.map((file) => file.path)).toEqual([
      ".gitignore",
      "docs/guide.md",
      "src/.gitignore",
      "src/index.ts",
    ]);
    expect(inventory.files.find((file) => file.path === "src/index.ts")?.hash).toBe(
      `sha256:${createHash("sha256").update("export const value = 1;\n").digest("hex")}`
    );
  });

  it("skips binary assets while keeping text-like files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-"));
    await mkdir(join(workspace, "assets"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Project\n");
    await writeFile(join(workspace, "assets", "logo.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(
      join(workspace, "assets", "unknown-binary"),
      Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72])
    );
    await writeFile(join(workspace, "assets", "fixture.txt"), "hello\nworld\n");

    const inventory = await listProjectFilesForL1(workspace);

    expect(inventory.files.map((file) => file.path)).toEqual(["assets/fixture.txt", "README.md"]);
    expect(inventory.files.every((file) => file.hash.startsWith("sha256:"))).toBe(true);
  });

  it("writes the L1 queue into the generated cache", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await initializeKnowledgeBase(workspace);

    const result = await compileKnowledgeBase(workspace);
    const queue = JSON.parse(await readFile(result.queuePath, "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

    expect(result.queuedFiles.map((file) => file.path)).toEqual([".gitignore", "src/index.ts"]);
    expect(result.queuedFiles.find((file) => file.path === "src/index.ts")?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(queue.queuedFiles).toEqual(result.queuedFiles);
    expect(manifest.queuedFileCount).toBe(2);
  });

  it("compiles empty in-scope work into valid zero-count queue and manifest artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-"));
    await initializeKnowledgeBase(workspace);

    const result = await compileKnowledgeBase(workspace);
    const queue = JSON.parse(await readFile(result.queuePath, "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const l1Entries = await readdir(join(workspace, "topchester-kb", "l1-files"));

    expect(result.queuedFiles).toEqual([]);
    expect(queue.queuedFiles).toEqual([]);
    expect(manifest.queuedFileCount).toBe(0);
    expect(manifest.l1).toEqual({ queued: 0, completed: 0, failed: 0, changed: 0, missing: 0, currentEntries: 0 });
    expect(l1Entries).toEqual([]);
  });

  it("excludes default and configured generated KB/cache artifact paths from inventory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-"));
    process.env.TOPCHESTER_KB_DIR = "custom-kb";
    process.env.TOPCHESTER_KB_CACHE_DIR = "custom-cache";
    await initializeKnowledgeBase(workspace);
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });
    await mkdir(join(workspace, ".agents", "topchester-kb-cache"), { recursive: true });
    await mkdir(join(workspace, ".agents", "topchester"), { recursive: true });
    await mkdir(join(workspace, "custom-kb", "l1-files"), { recursive: true });
    await mkdir(join(workspace, "custom-cache"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(workspace, "topchester-kb", "generated.json"), "{}\n");
    await writeFile(join(workspace, ".agents", "topchester-kb-cache", "queue.json"), "{}\n");
    await writeFile(join(workspace, ".agents", "topchester", "state.json"), "{}\n");
    await writeFile(join(workspace, "custom-kb", "manifest.json"), "{}\n");
    await writeFile(join(workspace, "custom-cache", "l1-queue.json"), "{}\n");

    const result = await compileKnowledgeBase(workspace);

    expect(result.queuePath).toBe(join(workspace, "custom-cache", "l1-queue.json"));
    expect(result.manifestPath).toBe(join(workspace, "custom-kb", "manifest.json"));
    expect(result.queuedFiles.map((file) => file.path)).toEqual(["src/index.ts"]);
    await rm(workspace, { recursive: true, force: true });
  });
});
