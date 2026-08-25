import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { syncL1File } from "../src/knowledge/compiler/index.js";
import { getL1FileEntryPath } from "../src/knowledge/compiler/path-encoding.js";
import { initializeKnowledgeBase } from "../src/knowledge/init.js";

function fakeModel(options: { onCall?: () => Promise<void> } = {}) {
  return {
    calls: 0,
    async generateText() {
      this.calls += 1;
      await options.onCall?.();
      return {
        text: JSON.stringify({
          language: "typescript",
          summary: "Exports a value used by the fixture.",
          responsibilities: ["Export the fixture value."],
          symbols: [],
          imports: [],
          exports: ["value"],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/value.ts" }],
          confidence: "medium",
        }),
        providerId: "fake",
        modelId: "fake-l1",
        purpose: "kb.summarize" as const,
      };
    },
  };
}

async function makeWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-sync-file-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await initializeKnowledgeBase(workspace);
  return workspace;
}

describe("single-file L1 sync", () => {
  it("writes one entry without creating a batch queue and skips the current SHA", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");

    const first = await syncL1File(workspace, { path: "src/value.ts", model });
    const second = await syncL1File(workspace, { path: "src/value.ts", model });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("skipped_current");
    expect(model.calls).toBe(1);
    await expect(readFile(getL1FileEntryPath(first.kbPath, "src/value.ts"), "utf8")).resolves.toContain(
      '"scan_status": "current"'
    );
    await expect(stat(join(workspace, ".agents", "topchester-kb-cache", "l1-sync-queue.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs the model again after the file hash changes", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    const path = join(workspace, "src", "value.ts");
    await writeFile(path, "export const value = 1;\n");
    await syncL1File(workspace, { path: "src/value.ts", model });
    await writeFile(path, "export const value = 2;\n");

    await expect(syncL1File(workspace, { path: "src/value.ts", model })).resolves.toMatchObject({
      status: "completed",
    });
    expect(model.calls).toBe(2);
  });

  it("reports changed when the file changes while the model is working", async () => {
    const workspace = await makeWorkspace();
    const path = join(workspace, "src", "value.ts");
    await writeFile(path, "export const value = 1;\n");
    const model = fakeModel({ onCall: () => writeFile(path, "export const value = 2;\n") });

    await expect(syncL1File(workspace, { path: "src/value.ts", model })).resolves.toMatchObject({ status: "changed" });
    await expect(
      readFile(getL1FileEntryPath(join(workspace, "topchester-kb"), "src/value.ts"), "utf8")
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns clear missing and ignored outcomes without model calls", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    await mkdir(join(workspace, "generated"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "ignored.ts\ngenerated/\n");
    await writeFile(join(workspace, "ignored.ts"), "ignored\n");
    await writeFile(join(workspace, "generated", "ignored.ts"), "ignored\n");
    await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2]));

    await expect(syncL1File(workspace, { path: "missing.ts", model })).resolves.toMatchObject({ status: "missing" });
    await expect(syncL1File(workspace, { path: "ignored.ts", model })).resolves.toMatchObject({
      status: "ignored",
      reason: "gitignore",
    });
    await expect(syncL1File(workspace, { path: "generated/ignored.ts", model })).resolves.toMatchObject({
      status: "ignored",
      reason: "gitignore",
    });
    await expect(syncL1File(workspace, { path: "binary.dat", model })).resolves.toMatchObject({
      status: "ignored",
      reason: "binary",
    });
    expect(model.calls).toBe(0);
  });

  it("requires an initialized KB and a model only when work is needed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-sync-file-missing-kb-"));
    await writeFile(join(workspace, "value.ts"), "export const value = 1;\n");
    await expect(syncL1File(workspace, { path: "value.ts" })).rejects.toThrow("topchester kb init");

    await initializeKnowledgeBase(workspace);
    await expect(syncL1File(workspace, { path: "value.ts" })).rejects.toThrow(
      'No model configured for purpose "kb.summarize"'
    );
  });
});
