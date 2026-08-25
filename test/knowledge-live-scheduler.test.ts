import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { editWorkspaceFile } from "../src/agent/tools/edit-file.js";
import { readWorkspaceFile } from "../src/agent/tools/read-file.js";
import { type TopchesterConfig } from "../src/config/index.js";
import { LiveL1Scheduler, type LiveL1TouchEvent } from "../src/knowledge/live-scheduler.js";
import { initializeKnowledgeBase } from "../src/knowledge/init.js";

function fakeModel(onCall?: (call: number) => Promise<void>) {
  return {
    calls: [] as string[],
    async generateText(request: { prompt: string }) {
      this.calls.push(request.prompt);
      await onCall?.(this.calls.length);
      return {
        text: JSON.stringify({
          language: "typescript",
          summary: "Exports a fixture value.",
          responsibilities: ["Export a fixture value."],
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

async function makeWorkspace(withKb = true) {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-live-scheduler-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  if (withKb) await initializeKnowledgeBase(workspace);
  return workspace;
}

function createScheduler(
  workspaceRoot: string,
  config: TopchesterConfig,
  model: ReturnType<typeof fakeModel> | undefined,
  onSynced?: (event: LiveL1TouchEvent) => void
) {
  return new LiveL1Scheduler({
    workspaceRoot,
    getConfig: () => config,
    getModel: () => model,
    debounceMs: 5,
    onSynced,
  });
}

describe("live L1 scheduler", () => {
  it("coalesces rapid touches to the latest hash and runs one model call", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    const scheduler = createScheduler(workspace, { knowledge: { live: true } }, model);
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 2;\n");
    scheduler.start();

    scheduler.enqueue({ path: "src/value.ts", hash: `sha256:${"1".repeat(64)}`, reason: "read" });
    scheduler.enqueue({ path: "src/value.ts", hash: await hashFromRead(workspace), reason: "edit" });
    await scheduler.waitForIdle();

    expect(model.calls).toHaveLength(1);
    expect(scheduler.snapshot()).toMatchObject({ enabled: true, queued: 0, syncing: false });
  });

  it("does not enqueue when live is off or the KB directory is missing", async () => {
    const workspace = await makeWorkspace(false);
    const model = fakeModel();
    const config: TopchesterConfig = { knowledge: { live: false } };
    const scheduler = createScheduler(workspace, config, model);
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    scheduler.start();

    expect(scheduler.enqueue({ path: "src/value.ts", hash: await hashFromRead(workspace), reason: "read" })).toBe(
      false
    );
    config.knowledge!.live = true;
    expect(scheduler.enqueue({ path: "src/value.ts", hash: await hashFromRead(workspace), reason: "read" })).toBe(
      false
    );
    expect(model.calls).toHaveLength(0);
  });

  it("uses the current-entry SHA skip and remembers completed hashes", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    const scheduler = createScheduler(workspace, { knowledge: { live: true } }, model);
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const hash = await hashFromRead(workspace);
    scheduler.start();
    scheduler.enqueue({ path: "src/value.ts", hash, reason: "read" });
    await scheduler.waitForIdle();

    expect(scheduler.enqueue({ path: "src/value.ts", hash, reason: "read" })).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  it("collapses a read followed by an edit and syncs the edited hash", async () => {
    const workspace = await makeWorkspace();
    const model = fakeModel();
    const synced: LiveL1TouchEvent[] = [];
    const scheduler = createScheduler(workspace, { knowledge: { live: true } }, model, (event) => synced.push(event));
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    scheduler.start();
    const onFileTouch = (event: LiveL1TouchEvent) => scheduler.enqueue(event);

    await readWorkspaceFile(workspace, "src/value.ts", { onFileTouch });
    const edited = await editWorkspaceFile(
      workspace,
      { path: "src/value.ts", edits: [{ old_text: "value = 1", new_text: "value = 2" }] },
      { onFileTouch }
    );
    await scheduler.waitForIdle();

    expect(model.calls).toHaveLength(1);
    expect(synced.at(-1)).toMatchObject({ path: "src/value.ts", hash: edited.afterHash, reason: "edit" });
  });

  it("records a missing KB model as background scheduler state", async () => {
    const workspace = await makeWorkspace();
    const scheduler = createScheduler(workspace, { knowledge: { live: true } }, undefined);
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    scheduler.start();
    scheduler.enqueue({ path: "src/value.ts", hash: await hashFromRead(workspace), reason: "read" });
    await scheduler.waitForIdle();

    expect(scheduler.snapshot().lastError).toContain('No model configured for purpose "kb.summarize"');
  });

  it("requeues the latest hash when a file changes during summarization", async () => {
    const workspace = await makeWorkspace();
    const path = join(workspace, "src", "value.ts");
    await writeFile(path, "export const value = 1;\n");
    const model = fakeModel(async (call) => {
      if (call === 1) await writeFile(path, "export const value = 2;\n");
    });
    const scheduler = createScheduler(workspace, { knowledge: { live: true } }, model);
    scheduler.start();
    scheduler.enqueue({ path: "src/value.ts", hash: await hashFromRead(workspace), reason: "read" });
    await scheduler.waitForIdle();

    expect(model.calls).toHaveLength(2);
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, syncing: false });
    expect(scheduler.snapshot()).not.toHaveProperty("lastError");
  });
});

async function hashFromRead(workspace: string): Promise<string> {
  return (await readWorkspaceFile(workspace, "src/value.ts")).hash;
}
