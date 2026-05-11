import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileKnowledgeBase } from "../src/knowledge/compiler/index.js";
import { listProjectFilesForL1 } from "../src/knowledge/compiler/inventory.js";
import { initializeKnowledgeBase } from "../src/knowledge/init.js";

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
});
