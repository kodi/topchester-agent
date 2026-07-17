import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { agentEvent } from "../src/agent/events.js";
import { type AgentRuntime } from "../src/agent/runtime/index.js";
import { TopchesterTuiController } from "../src/chat/controller.js";
import { type TopchesterConfig } from "../src/config/index.js";
import { createSession, loadSession } from "../src/session/store.js";
import { createTestContext } from "./app-context.fixtures.js";

function createControllerRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    async checkAgent() {
      return [];
    },
    async checkKnowledgeBase() {
      return [];
    },
    async submitSlashCommand() {
      return [];
    },
    async *submitMessageStream() {
      yield agentEvent.assistantMessage("fixture answer", "model");
    },
    async submitMessage() {
      return [];
    },
    ...overrides,
  };
}

describe("framework-neutral TUI controller", () => {
  it("initializes a semantic snapshot and persists structured startup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-startup-"));
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      banner: "TOPCHESTER",
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.sessionId).toBeTruthy();
    expect(snapshot.modelLabel).toBe("not set");
    expect(snapshot.startupHint).toContain("Enter sends");
    expect(snapshot.transcript).toEqual([
      expect.objectContaining({ kind: "startup", persistence: "session", banner: "TOPCHESTER" }),
    ]);
    expect((await loadSession(workspace, snapshot.sessionId)).events).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "system",
        meta: expect.objectContaining({ source: "startup" }),
      }),
    ]);

    await controller.dispose();
  });

  it("streams reasoning as display-only state and persists only conversation entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-reasoning-"));
    const previous = process.env.TOPCHESTER_STREAM_REASONING;
    process.env.TOPCHESTER_STREAM_REASONING = "1";
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, _message, _signal, options) {
        await options?.onReasoning?.({ type: "delta", text: "**Inspecting**" });
        yield agentEvent.assistantMessage("Done", "model");
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    try {
      expect(controller.submit("Fix it")).toBe("submitted");
      await controller.waitForIdle();

      expect(controller.getSnapshot().transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "user", text: "Fix it" }),
          expect.objectContaining({ kind: "reasoning", persistence: "display", text: "Inspecting" }),
          expect.objectContaining({ kind: "assistant", text: "Done" }),
        ])
      );
      const events = (await loadSession(workspace, controller.getSnapshot().sessionId)).events;
      expect(events.map((event) => event.kind)).toEqual(["message", "message", "message"]);
      expect(JSON.stringify(events)).not.toContain("Inspecting");
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_STREAM_REASONING;
      } else {
        process.env.TOPCHESTER_STREAM_REASONING = previous;
      }
      await controller.dispose();
    }
  });

  it("queues normal and unconsumed steering prompts in FIFO order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-queue-"));
    let releaseFirst: () => void = () => {};
    const firstTurn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const submitted: string[] = [];
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, message) {
        submitted.push(message);
        if (submitted.length === 1) {
          await firstTurn;
        }
        yield agentEvent.assistantMessage(`answer: ${message}`, "model");
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submit("first");
    await vi.waitFor(() => expect(submitted).toEqual(["first"]));
    expect(controller.submit("second")).toBe("queued");
    expect(controller.submitCommand("/steer third")).toBe("queued");
    expect(controller.getSnapshot().queuedFollowUpCount).toBe(1);
    releaseFirst();
    await controller.waitForIdle();

    expect(submitted).toEqual(["first", "second", "third"]);
    expect(controller.getSnapshot().queuedFollowUpCount).toBe(0);
    await controller.dispose();
  });

  it("cancels an old turn and drops queued input when switching sessions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-switch-race-"));
    let turnStarted = false;
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, _message, signal) {
        turnStarted = true;
        const abortSignal = signal ?? new AbortController().signal;
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (!abortSignal.aborted) {
          yield agentEvent.assistantMessage("stale answer", "model");
        }
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);
    const oldSessionId = controller.getSnapshot().sessionId;

    controller.submit("old prompt");
    await vi.waitFor(() => expect(turnStarted).toBe(true));
    controller.submit("queued prompt");
    controller.submitCommand("/steer pending guidance");
    controller.submitCommand("/new");
    await controller.waitForIdle();

    const snapshot = controller.getSnapshot();
    expect(snapshot.sessionId).not.toBe(oldSessionId);
    expect(snapshot.queuedFollowUpCount).toBe(0);
    expect(snapshot.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "startup" }),
        expect.objectContaining({
          kind: "system",
          text: "Dropped 1 queued follow-up. Dropped pending steering.",
        }),
      ])
    );
    expect(JSON.stringify(snapshot.transcript)).not.toContain("stale answer");
    await controller.dispose();
  });

  it("exposes typed managed dialogs and resolves them through semantic actions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-dialog-"));
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime());

    controller.submitCommand("/connect");
    await controller.waitForIdle();
    expect(controller.getSnapshot()).toMatchObject({
      managedDialog: true,
      transcript: [
        expect.anything(),
        expect.objectContaining({ kind: "user", text: "/connect" }),
        expect.objectContaining({ kind: "choice", title: "Connect provider" }),
      ],
    });

    controller.choose({ label: "Cancel", value: "cancel" });
    expect(controller.getSnapshot().managedDialog).toBe(false);
    expect(controller.getSnapshot().transcript.at(-1)?.kind).not.toBe("choice");
    await controller.dispose();
  });

  it("aborts active work and settles it before disposal returns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-dispose-"));
    let aborted = false;
    const runtime = createControllerRuntime({
      async checkAgent(signal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          );
        });
        return [];
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().canCancel).toBe(true));

    await controller.dispose();

    expect(aborted).toBe(true);
  });

  it("cancels an active chat through the renderer-neutral action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-cancel-"));
    let aborted = false;
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, _message, signal) {
        yield* [];
        if (signal?.aborted) {
          aborted = true;
          return;
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          );
        });
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submit("stop this turn");
    await vi.waitFor(() => expect(controller.getSnapshot().canCancel).toBe(true));
    controller.cancel();
    await controller.waitForIdle();

    expect(aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ canCancel: false, status: "ready" });
    await controller.dispose();
  });

  it("routes runtime choices back through the semantic submit path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-choice-"));
    const submitted: string[] = [];
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, message) {
        submitted.push(message);
        if (message === "start") {
          yield agentEvent.choice({
            tone: "warning",
            title: "Continue?",
            actions: [
              { label: "Continue", value: "continue with the task" },
              { label: "Abort", value: "__abort__" },
            ],
          });
        } else {
          yield agentEvent.assistantMessage("continued", "model");
        }
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submit("start");
    await controller.waitForIdle();
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "choice", title: "Continue?" });
    controller.choose({ label: "Continue", value: "continue with the task" });
    await controller.waitForIdle();

    expect(submitted).toEqual(["start", "continue with the task"]);
    expect(controller.getSnapshot().transcript).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: "continued" })])
    );
    await controller.dispose();
  });

  it("resolves bash approval without leaking renderer state into the runtime", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-approval-"));
    let decision: string | undefined;
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, _message, _signal, options) {
        decision = await options?.requestBashApproval?.({
          command: "pnpm test",
          workdir: workspace,
          reason: "run tests",
          candidates: { exact: ["pnpm test"], prefix: ["pnpm"] },
        });
        yield agentEvent.assistantMessage(`approval: ${decision}`, "model");
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submit("verify");
    await vi.waitFor(() =>
      expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "choice", title: "Run bash command?" })
    );
    controller.choose({ label: "Run once", value: "run_once" });
    await controller.waitForIdle();

    expect(decision).toBe("run_once");
    expect(controller.getSnapshot().managedDialog).toBe(false);
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({
      kind: "assistant",
      text: "approval: run_once",
    });
    await controller.dispose();
  });

  it("applies model and effort choices as session-scoped overrides", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-model-"));
    const context = createTestContext(workspace);
    const config: TopchesterConfig = {
      models: {
        defaultPurpose: "agent.primary",
        assignments: { "agent.primary": { name: "model-a", provider: "fake" } },
        choices: [
          { name: "model-a", provider: "fake" },
          { name: "model-b", provider: "fake" },
        ],
      },
      providers: {
        fake: { type: "openai-compatible", baseURL: "https://example.invalid/v1", apiKey: "fake" },
      },
    };
    context.baseConfig = config;
    context.config = config;
    const controller = await TopchesterTuiController.create(context, createControllerRuntime());

    controller.submitCommand("/model");
    await controller.waitForIdle();
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "choice", title: "Choose model" });
    controller.choose({ label: "model-b [fake]", value: "model:fake/model-b" });
    await controller.waitForIdle();
    controller.submitCommand("/effort max");
    await controller.waitForIdle();

    expect(context.runtimeConfigOverrides.activeModel).toEqual({ name: "model-b", provider: "fake" });
    expect(context.runtimeConfigOverrides.reasoningEffortByProvider).toEqual({ fake: "max" });
    expect(controller.getSnapshot().modelLabel).toContain("model-b [fake]");
    expect(controller.getSnapshot().modelLabel).toContain("effort max");
    await controller.dispose();
  });

  it("restores and forks sessions through append-only semantic resets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-session-actions-"));
    const source = await createSession(workspace);
    await source.append({ kind: "message", role: "user", text: "source prompt" });
    await source.append({ kind: "message", role: "assistant", text: "source answer" });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime());

    controller.submitCommand("/restore");
    await controller.waitForIdle();
    const sourcePickerItem = controller
      .getSnapshot()
      .sessionPicker?.items.find((item) => item.sessionId === source.sessionId);
    expect(sourcePickerItem).toMatchObject({ title: "source prompt", firstUserPrompt: "source prompt" });
    controller.selectSession(source.sessionId);
    await controller.waitForIdle();
    expect(controller.getSnapshot()).toMatchObject({ sessionId: source.sessionId, sessionEpoch: 1 });
    expect(controller.getSnapshot().transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "source prompt" }),
        expect.objectContaining({ kind: "system", text: expect.stringContaining("Restored session") }),
      ])
    );

    controller.submitCommand("/fork");
    await controller.waitForIdle();
    expect(controller.getSnapshot().sessionId).not.toBe(source.sessionId);
    expect(controller.getSnapshot().sessionEpoch).toBe(2);
    expect((await loadSession(workspace, controller.getSnapshot().sessionId)).metadata.title).toBe("source prompt");
    expect(controller.getSnapshot().transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "system", text: expect.stringContaining("Forked session") }),
      ])
    );
    await controller.dispose();
  });

  it("exposes skills, task-plan, hook, and knowledge state semantically", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-semantic-state-"));
    const skillDir = join(workspace, ".agents", "skills", "fixture-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture skill\n---\n\nUse it.\n"
    );
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime());
    const knowledgeStatus = {
      workspaceRoot: workspace,
      kbPath: join(workspace, "topchester-kb"),
      cachePath: join(workspace, ".agents", "topchester-kb-cache"),
      kbExists: false,
      kbIsDirectory: false,
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default" as const,
      cachePathSource: "default" as const,
    };

    await controller.applyRuntimeEvents([
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:00.000Z",
        items: [{ text: "Implement UI", status: "in_progress" }],
      }),
      agentEvent.hookStatus("PreToolUse", "Checking"),
      agentEvent.knowledgeStatus(knowledgeStatus, "Run /kb init"),
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      taskPlan: { items: [{ text: "Implement UI", status: "in_progress" }] },
      temporaryLine: expect.stringContaining("Checking"),
      knowledgeStatus,
    });

    controller.submitCommand("/skills");
    await controller.waitForIdle();
    expect(controller.getSnapshot()).toMatchObject({
      taskPlan: undefined,
      managedDialog: true,
    });
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "choice", title: "Skills" });
    controller.dismissDialog();
    await controller.dispose();
  });
});
