import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { agentEvent } from "../src/agent/events.js";
import { type AgentRuntime } from "../src/agent/runtime/index.js";
import { TopchesterTuiController } from "../src/chat/controller.js";
import { type TuiTransientScheduler } from "../src/chat/controller-state.js";
import { type TopchesterConfig } from "../src/config/index.js";
import { type HerdrAgentReport, type HerdrAgentReporter } from "../src/integrations/herdr.js";
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
  it("reduces runtime events without awaiting routine session durability", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-nonblocking-persistence-"));
    const session = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session,
    });
    const enqueue = vi.spyOn(session, "enqueue").mockReturnValue({} as never);
    const flush = vi.spyOn(session, "flush");

    await controller.applyRuntimeEvents([agentEvent.status("visible before durable")]);

    expect(controller.getSnapshot().status).toBe("visible before durable");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
    enqueue.mockRestore();
    flush.mockRestore();
    await controller.dispose();
  });

  it("surfaces a terminal session writer failure exactly once at durability barriers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-persistence-failure-"));
    const session = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session,
    });
    vi.spyOn(session, "flush").mockRejectedValue(new Error("journal unavailable"));

    await controller.waitForIdle();
    await controller.waitForIdle();

    const warnings = controller
      .getSnapshot()
      .transcript.filter((entry) => entry.kind === "system" && entry.text.includes("Session save failed"));
    expect(warnings).toEqual([expect.objectContaining({ text: expect.stringContaining("journal unavailable") })]);
    await controller.dispose();
  });

  it("waits for the active session durability barrier before disposal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-dispose-durability-"));
    const session = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session,
    });
    await controller.applyRuntimeEvents([agentEvent.status("durable on dispose")]);
    const originalFlush = session.flush.bind(session);
    let releaseFlush: () => void = () => {};
    const blockedFlush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    vi.spyOn(session, "flush")
      .mockImplementationOnce(() => blockedFlush)
      .mockImplementation(originalFlush);
    let disposed = false;

    const disposal = controller.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    releaseFlush();
    await disposal;

    expect((await loadSession(workspace, session.sessionId)).events).toEqual([
      expect.objectContaining({ kind: "status", status: "durable on dispose" }),
    ]);
  });

  it("does not switch sessions until the source durability barrier resolves", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-switch-durability-"));
    const source = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session: source,
    });
    const originalFlush = source.flush.bind(source);
    let releaseFlush: () => void = () => {};
    const blockedFlush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const flush = vi
      .spyOn(source, "flush")
      .mockImplementationOnce(() => blockedFlush)
      .mockImplementation(originalFlush);

    controller.submitCommand("/new");
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    expect(controller.getSnapshot().sessionId).toBe(source.sessionId);
    releaseFlush();
    await controller.waitForIdle();

    expect(controller.getSnapshot().sessionId).not.toBe(source.sessionId);
    await controller.dispose();
  });

  it("unblocks the active session when a restore transition fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-restore-recovery-"));
    const source = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session: source,
    });
    controller.submitCommand("/restore");
    await controller.waitForIdle();
    controller.selectSession("00000000-0000-7000-8000-000000000001");
    await controller.waitForIdle();
    const enqueue = vi.spyOn(source, "enqueue");

    await controller.applyRuntimeEvents([agentEvent.status("persist after failed restore")]);
    await controller.waitForIdle();

    expect(controller.getSnapshot().sessionId).toBe(source.sessionId);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().transcript).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Restore failed") })])
    );
    await controller.dispose();
  });

  it("aborts a session boundary when the source durability barrier fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-failed-boundary-"));
    const source = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session: source,
    });
    vi.spyOn(source, "flush").mockRejectedValue(new Error("source barrier failed"));

    controller.submitCommand("/fork");
    await controller.waitForIdle();
    const enqueue = vi.spyOn(source, "enqueue");
    await controller.applyRuntimeEvents([agentEvent.status("must not enqueue after terminal failure")]);

    expect(controller.getSnapshot().sessionId).toBe(source.sessionId);
    expect(enqueue).not.toHaveBeenCalled();
    const warnings = controller
      .getSnapshot()
      .transcript.filter((entry) => entry.kind === "system" && entry.text.includes("Session save failed"));
    expect(warnings).toEqual([expect.objectContaining({ text: expect.stringContaining("source barrier failed") })]);
    expect(JSON.stringify(controller.getSnapshot().transcript)).not.toContain("Forked session");
    await controller.dispose();
  });

  it("does not redirect backpressured old-session events into a replacement session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-old-session-persistence-"));
    const oldSession = await createSession(workspace);
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      session: oldSession,
    });
    let releaseBackpressure: () => void = () => {};
    const backpressure = new Promise<never>((resolve) => {
      releaseBackpressure = () => resolve({} as never);
    });
    const enqueue = vi.spyOn(oldSession, "enqueue").mockReturnValueOnce(backpressure);
    const applying = controller.applyRuntimeEvents([agentEvent.status("old one"), agentEvent.status("old two")]);

    controller.submitCommand("/new");
    await vi.waitFor(() => expect(controller.getSnapshot().sessionId).not.toBe(oldSession.sessionId));
    releaseBackpressure();
    await applying;
    await controller.waitForIdle();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const replacement = await loadSession(workspace, controller.getSnapshot().sessionId);
    expect(JSON.stringify(replacement.events)).not.toContain("old one");
    expect(JSON.stringify(replacement.events)).not.toContain("old two");
    await controller.dispose();
  });

  it("publishes each chat start and final busy transition once", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-publications-"));
    let release: () => void = () => {};
    let started = false;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = await TopchesterTuiController.create(
      createTestContext(workspace),
      createControllerRuntime({
        async *submitMessageStream() {
          started = true;
          await pending;
          yield agentEvent.assistantMessage("done", "fixture");
        },
      }),
      { transientScheduler: new FakeTransientScheduler() }
    );
    const snapshots: Array<{ status: string; canCancel: boolean; promptHint?: string; queued: number }> = [];
    controller.subscribe((snapshot) =>
      snapshots.push({
        status: snapshot.status,
        canCancel: snapshot.canCancel,
        promptHint: snapshot.promptHint,
        queued: snapshot.queuedFollowUpCount,
      })
    );
    controller.submit("one turn");
    await vi.waitFor(() => expect(started).toBe(true));

    expect(snapshots.filter((snapshot) => snapshot.status === "thinking")).toEqual([
      expect.objectContaining({ canCancel: true, queued: 0 }),
    ]);
    release();
    await controller.waitForIdle();

    expect(snapshots.at(-1)).toMatchObject({ status: "ready", canCancel: false, queued: 0 });
    await controller.dispose();
  });

  it("coalesces hook bursts behind stable runtime updates", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-hook-scheduler-"));
    const scheduler = new FakeTransientScheduler();
    const controller = await TopchesterTuiController.create(createTestContext(workspace), createControllerRuntime(), {
      transientScheduler: scheduler,
    });
    const publications: string[] = [];
    controller.subscribe((snapshot) => publications.push(snapshot.temporaryLine ?? snapshot.status));

    await controller.applyRuntimeEvents([
      agentEvent.hookStatus("PreToolUse", "first"),
      agentEvent.status("thinking"),
      agentEvent.hookStatus("PostToolUse", "last"),
    ]);
    expect(controller.getSnapshot().status).toBe("thinking");
    expect(controller.getSnapshot().temporaryLine).toBeUndefined();
    expect(publications).toEqual(["thinking"]);
    scheduler.flush();
    expect(controller.getSnapshot().temporaryLine).toContain("last");
    await controller.dispose();
  });
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
    let releaseSecond: () => void = () => {};
    const secondTurn = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const submitted: string[] = [];
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, message) {
        submitted.push(message);
        if (submitted.length === 1) {
          await firstTurn;
        } else if (submitted.length === 2) {
          await secondTurn;
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
    expect(controller.getSnapshot().queuedFollowUpPreview).toBe("second");
    releaseFirst();
    await vi.waitFor(() => expect(submitted).toEqual(["first", "second"]));
    expect(controller.getSnapshot().queuedFollowUpCount).toBe(1);
    expect(controller.getSnapshot().queuedFollowUpPreview).toBe("third");
    releaseSecond();
    await controller.waitForIdle();

    expect(submitted).toEqual(["first", "second", "third"]);
    expect(controller.getSnapshot().queuedFollowUpCount).toBe(0);
    expect(controller.getSnapshot().queuedFollowUpPreview).toBeUndefined();
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
    expect(snapshot.queuedFollowUpPreview).toBeUndefined();
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

  it("cancels an active slash command through the renderer-neutral action", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-command-cancel-"));
    let receivedSignal: AbortSignal | undefined;
    const runtime = createControllerRuntime({
      async submitSlashCommand(_command, _onProgress, signal) {
        receivedSignal = signal;
        signal?.throwIfAborted();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
        );
        return [];
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submitCommand("/kb sync");
    await vi.waitFor(() => expect(controller.getSnapshot().canCancel).toBe(true));
    expect(controller.cancel()).toBe(true);
    await controller.waitForIdle();

    expect(receivedSignal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ canCancel: false, status: "ready" });
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "system", text: "Command stopped." });
    expect(controller.cancel()).toBe(false);
    await controller.dispose();
  });

  it("handles an immediate follow-up during a yielded runtime flood", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-runtime-flood-input-"));
    const submitted: string[] = [];
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, message) {
        submitted.push(message);
        if (message === "flood") {
          for (let index = 0; index < 300; index += 1) yield agentEvent.status(`flood-${index}`);
          yield agentEvent.status("ready");
        } else {
          yield agentEvent.assistantMessage(`answer: ${message}`, "model");
        }
      },
    });
    let clock = 0;
    let injected = false;
    let statusAtInjection: string | undefined;
    let controller!: TopchesterTuiController;
    controller = await TopchesterTuiController.create(createTestContext(workspace), runtime, {
      runtimeDrainClock: () => (clock += 5),
      runtimeDrainScheduler: async () => {
        if (!injected) {
          injected = true;
          statusAtInjection = controller.getSnapshot().status;
          expect(controller.submit("follow-up")).toBe("queued");
          expect(controller.getSnapshot().queuedFollowUpCount).toBe(1);
        }
      },
    });

    controller.submit("flood");
    await controller.waitForIdle();

    expect(injected).toBe(true);
    expect(statusAtInjection).not.toBe("flood-299");
    expect(submitted).toEqual(["flood", "follow-up"]);
    await controller.dispose();
  });

  it("cancels a saturated runtime producer during a host yield and returns its source iterator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-runtime-flood-cancel-"));
    let produced = 0;
    let sourceReturned = false;
    const runtime = createControllerRuntime({
      async *submitMessageStream() {
        try {
          for (let index = 0; index < 300; index += 1) {
            produced += 1;
            yield agentEvent.status(`cancel-flood-${index}`);
          }
        } finally {
          sourceReturned = true;
        }
      },
    });
    let clock = 0;
    let producedAtCancel = 0;
    let controller!: TopchesterTuiController;
    controller = await TopchesterTuiController.create(createTestContext(workspace), runtime, {
      runtimeDrainClock: () => (clock += 5),
      runtimeDrainScheduler: async () => {
        if (producedAtCancel === 0) {
          producedAtCancel = produced;
          controller.cancel();
        }
      },
    });

    controller.submit("cancel flood");
    await controller.waitForIdle();

    expect(producedAtCancel).toBeGreaterThan(0);
    expect(producedAtCancel).toBeLessThan(300);
    expect(sourceReturned).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ canCancel: false, status: "ready" });
    await controller.dispose();
  });

  it("disposal aborts a saturated runtime producer and unblocks its source iterator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-runtime-flood-dispose-"));
    let sourceReturned = false;
    const runtime = createControllerRuntime({
      async *submitMessageStream() {
        try {
          for (let index = 0; index < 300; index += 1) yield agentEvent.status(`dispose-flood-${index}`);
        } finally {
          sourceReturned = true;
        }
      },
    });
    let clock = 0;
    let disposal: Promise<void> | undefined;
    let controller!: TopchesterTuiController;
    controller = await TopchesterTuiController.create(createTestContext(workspace), runtime, {
      runtimeDrainClock: () => (clock += 5),
      runtimeDrainScheduler: async () => {
        disposal ??= controller.dispose();
      },
    });

    controller.submit("dispose flood");
    await vi.waitFor(() => expect(disposal).toBeDefined());
    await disposal;

    expect(sourceReturned).toBe(true);
  });

  it("propagates a runtime producer failure after draining events produced before it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-runtime-producer-error-"));
    const runtime = createControllerRuntime({
      async *submitMessageStream() {
        yield agentEvent.systemMessage("before producer failure");
        throw new Error("producer exploded");
      },
    });
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);

    controller.submit("fail stream");
    await controller.waitForIdle();

    expect(controller.getSnapshot().transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "system", text: "before producer failure" }),
        expect.objectContaining({ kind: "system", text: expect.stringContaining("Chat failed: producer exploded") }),
      ])
    );
    expect(controller.getSnapshot().status).toBe("chat failed");
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
    const herdrReports: HerdrAgentReport[] = [];
    let herdrReleased = false;
    const herdrReporter: HerdrAgentReporter = {
      async report(report) {
        herdrReports.push(report);
      },
      async release() {
        herdrReleased = true;
      },
    };
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
    const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime, {
      herdrReporter,
    });

    controller.submit("verify");
    await vi.waitFor(() =>
      expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({ kind: "choice", title: "Run bash command?" })
    );
    expect(herdrReports.at(-1)).toMatchObject({
      state: "blocked",
      message: "Waiting for bash approval",
    });
    controller.choose({ label: "Run once", value: "run_once" });
    await controller.waitForIdle();

    expect(decision).toBe("run_once");
    expect(controller.getSnapshot().managedDialog).toBe(false);
    expect(controller.getSnapshot().transcript.at(-1)).toMatchObject({
      kind: "assistant",
      text: "approval: run_once",
    });
    expect(herdrReports.map((report) => report.state)).toContain("working");
    expect(herdrReports.at(-1)?.state).toBe("idle");
    await controller.dispose();
    expect(herdrReleased).toBe(true);
  });

  it("resolves an approval dialog during a yielded runtime backlog", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-controller-runtime-flood-approval-"));
    let decision: string | undefined;
    const runtime = createControllerRuntime({
      async *submitMessageStream(_conversation, _message, _signal, options) {
        for (let index = 0; index < 10; index += 1) yield agentEvent.status(`before-approval-${index}`);
        decision = await options?.requestBashApproval?.({
          command: "pnpm test",
          workdir: workspace,
          reason: "run tests",
          candidates: { exact: ["pnpm test"], prefix: ["pnpm"] },
        });
        for (let index = 0; index < 300; index += 1) yield agentEvent.status(`after-approval-${index}`);
        yield agentEvent.assistantMessage(`approval: ${decision}`, "model");
      },
    });
    let clock = 0;
    let choseDuringYield = false;
    let statusAtChoice: string | undefined;
    let controller!: TopchesterTuiController;
    controller = await TopchesterTuiController.create(createTestContext(workspace), runtime, {
      runtimeDrainClock: () => (clock += 5),
      runtimeDrainScheduler: async () => {
        if (choseDuringYield) return;
        await vi.waitFor(() => expect(controller.getSnapshot().managedDialog).toBe(true));
        choseDuringYield = true;
        statusAtChoice = controller.getSnapshot().status;
        controller.choose({ label: "Run once", value: "run_once" });
        expect(controller.getSnapshot().managedDialog).toBe(false);
      },
    });

    controller.submit("approval flood");
    await controller.waitForIdle();

    expect(choseDuringYield).toBe(true);
    expect(statusAtChoice).not.toBe("after-approval-299");
    expect(decision).toBe("run_once");
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
    await vi.waitFor(() => expect(controller.getSnapshot().temporaryLine).toContain("Checking"));
    expect(controller.getSnapshot()).toMatchObject({
      taskPlan: { items: [{ text: "Implement UI", status: "in_progress" }] },
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

class FakeTransientScheduler implements TuiTransientScheduler {
  private callback: (() => void) | undefined;
  schedule(callback: () => void): void {
    this.callback = callback;
  }
  cancel(): void {
    this.callback = undefined;
  }
  dispose(): void {
    this.cancel();
  }
  flush(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}
