/// <reference types="bun" />
/** @jsxImportSource @opentui/solid */

import {
  CliRenderEvents,
  RGBA,
  SyntaxStyle,
  type CliRendererExternalOutputEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEvent } from "../../src/agent/events.js";
import { type AgentRuntime } from "../../src/agent/runtime/index.js";
import { TopchesterTuiController } from "../../src/chat/controller.js";
import { reasoningTranscriptEntry, type TranscriptEntry } from "../../src/chat/index.js";
import { TopchesterApp } from "../../src/tui/opentui/app.js";
import { runOpenTui } from "../../src/tui/opentui/renderer.js";
import { ThreadEntry } from "../../src/tui/opentui/thread-entry.js";
import { createTopchesterSyntaxStyle, resolveTopchesterTheme } from "../../src/tui/opentui/theme.js";
import { TranscriptWriter } from "../../src/tui/opentui/transcript-writer.js";
import { createTestContext } from "../../test/app-context.fixtures.js";

function createRuntime(submitted?: string[]): AgentRuntime {
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
    async *submitMessageStream(_conversation, message) {
      submitted?.push(message);
      yield agentEvent.assistantMessage("fixture answer", "model");
    },
    async submitMessage() {
      return [];
    },
  };
}

await testAppSurface();
await testTranscriptWriter();
await testThreadEntryVariants();
await testAssistantMessage();
await testReasoningStyle();
await testNoColorSelection();
await testRenderFailureCleanup();

process.stdout.write("Production OpenTUI Bun renderer: pass\n");

async function testAppSurface(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-app-"));
  const submitted: string[] = [];
  const context = createTestContext(workspace);
  context.config = {
    ...context.config,
    models: {
      choices: Array.from({ length: 10 }, (_, index) => ({
        provider: "openrouter",
        name: index === 0 ? "provider/very-long-model-name-that-must-be-cleared" : `provider/model-${index + 1}`,
      })),
    },
  };
  const controller = await TopchesterTuiController.create(context, createRuntime(submitted));
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme();
  let interrupts = 0;
  const setup = await testRender(
    () => (
      <TopchesterApp
        controller={controller}
        initialSnapshot={controller.getSnapshot()}
        theme={theme}
        syntaxStyle={syntaxStyle}
        onInterrupt={() => {
          interrupts += 1;
        }}
      />
    ),
    { width: 80, height: 24, screenMode: "split-footer", footerHeight: 16, useMouse: false, exitOnCtrlC: false }
  );

  try {
    await setup.renderOnce();
    const composer = setup.renderer.root.findDescendantById("topchester-composer") as TextareaRenderable;
    assert.match(setup.captureCharFrame(), /Ask Topchester/u);
    assert.match(setup.captureCharFrame(), /not set/u);

    await setup.mockInput.typeText("/");
    await setup.flush();
    assert.ok(setup.renderer.footerHeight >= 10);
    assert.match(setup.captureCharFrame(), /\/model all/u);
    assert.match(setup.captureCharFrame(), /\/connect/u);

    await setup.mockInput.typeText("mo");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /\/model/u);

    setup.mockInput.pressCtrlC();
    assert.equal(interrupts, 1);

    controller.submitCommand("/connect");
    await controller.waitForIdle();
    await setup.flush();
    assert.ok(setup.renderer.footerHeight >= 10);
    assert.match(setup.captureCharFrame(), /Connect provider/u);
    assert.match(setup.captureCharFrame(), /OpenRouter/u);
    assert.match(setup.captureCharFrame(), /Cancel/u);
    assert.equal(composer.focused, false);

    await setup.mockInput.typeText(" draft stays");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.flush();
    assert.equal(controller.getSnapshot().managedDialog, false);
    assert.equal(composer.focused, true);
    assert.match(setup.captureCharFrame(), /\/mo/u);
    assert.doesNotMatch(setup.captureCharFrame(), /draft stays/u);

    composer.setText("");
    await setup.mockInput.typeText("/model");
    setup.mockInput.pressEnter();
    await controller.waitForIdle();
    await setup.flush();
    assert.ok(setup.renderer.footerHeight >= 16);
    assert.match(setup.captureCharFrame(), /Choose model/u);
    assert.match(setup.captureCharFrame(), /very-long-model-name-that-must-be-cleared/u);
    assert.match(setup.captureCharFrame(), /8\/11/u);

    for (let index = 0; index < 6; index += 1) {
      setup.mockInput.pressArrow("down");
    }
    await setup.flush();
    assert.doesNotMatch(setup.captureCharFrame(), /very-long-model-name-that-must-be-cleared/u);
    assert.match(setup.captureCharFrame(), /❯ 7\) provider\/model-7/u);
    for (let index = 0; index < 4; index += 1) {
      setup.mockInput.pressArrow("down");
    }
    setup.mockInput.pressEnter();
    await setup.flush();

    composer.setText("");
    const pasted = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n");
    await setup.mockInput.pasteBracketedText(pasted);
    await setup.flush();
    assert.match(setup.captureCharFrame(), /\[Pasted #1 7 lines 48 chars\]/u);
    setup.mockInput.pressEnter();
    await controller.waitForIdle();
    await setup.flush();
    assert.equal(submitted.at(-1), pasted);

    await setup.mockInput.typeText("history prompt");
    setup.mockInput.pressEnter();
    await controller.waitForIdle();
    setup.mockInput.pressArrow("up");
    await setup.flush();
    assert.equal(composer.plainText, "history prompt");
    setup.mockInput.pressArrow("down");
    await setup.flush();
    assert.equal(composer.plainText, "");

    for (const [width, height] of [
      [80, 24],
      [120, 40],
      [200, 60],
    ] as const) {
      setup.resize(width, height);
      await setup.flush();
      assert.match(setup.captureCharFrame(), /not set/u);
    }
  } finally {
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testTranscriptWriter(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-writer-"));
  const controller = await TopchesterTuiController.create(createTestContext(workspace), createRuntime(), {
    banner: "TOPCHESTER",
  });
  const theme = resolveTopchesterTheme();
  const syntaxStyle = createTopchesterSyntaxStyle(theme);
  const setup = await testRender(() => <box />, {
    width: 80,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  });
  const writer = new TranscriptWriter();

  try {
    writer.sync(setup.renderer, controller.getSnapshot(), theme, syntaxStyle);
    writer.sync(setup.renderer, controller.getSnapshot(), theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    const output = setup.externalOutput.take();
    assert.equal(output.length, 1);
    assert.match(output[0]?.text ?? "", /TOPCHESTER/u);

    let keywordColor: number[] | undefined;
    const captureHighlight = (event: CliRendererExternalOutputEvent) => {
      const keyword = event.snapshot
        .getSpanLines()
        .flatMap((line) => line.spans)
        .find((span) => span.text === "const");
      keywordColor = keyword?.fg.toInts();
    };
    setup.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, captureHighlight);
    try {
      const markdownTranscript: TranscriptEntry[] = [
        {
          kind: "assistant",
          persistence: "session",
          text: [
            "### YAML",
            "",
            "```yaml",
            "server:",
            "  port: 8080",
            "```",
            "",
            "### TypeScript",
            "",
            "```typescript",
            "const answer: number = 42;",
            "```",
            "",
            "### Go",
            "",
            "```go",
            "package main",
            "```",
          ].join("\n"),
        },
      ];
      const markdownSnapshot = { ...controller.getSnapshot(), transcript: markdownTranscript };
      writer.sync(setup.renderer, markdownSnapshot, theme, syntaxStyle);
      writer.sync(setup.renderer, markdownSnapshot, theme, syntaxStyle);
      await writer.idle();
      await setup.flush();
    } finally {
      setup.renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, captureHighlight);
    }
    const markdownOutput = setup.externalOutput.take();
    assert.equal(markdownOutput.length, 1);
    const markdownText = markdownOutput[0]?.text ?? "";
    for (const marker of [
      "YAML",
      "server:",
      "port: 8080",
      "TypeScript",
      "const answer: number = 42;",
      "Go",
      "package main",
    ]) {
      assert.match(markdownText, new RegExp(marker, "u"));
    }
    assert.doesNotMatch(markdownText, /```|###/u);
    assert.deepEqual(keywordColor, RGBA.fromHex(theme.accent).toInts());

    writer.sync(
      setup.renderer,
      {
        ...controller.getSnapshot(),
        sessionId: "restored-session",
        sessionEpoch: 1,
        transcript: [{ kind: "user", persistence: "session", text: "restored prompt" }],
      },
      theme,
      syntaxStyle
    );
    writer.sync(
      setup.renderer,
      {
        ...controller.getSnapshot(),
        sessionId: "restored-session",
        sessionEpoch: 1,
        transcript: [{ kind: "user", persistence: "session", text: "restored prompt" }],
      },
      theme,
      syntaxStyle
    );
    await writer.idle();
    await setup.flush();
    const replay = setup.externalOutput.take();
    assert.equal(replay.length, 2);
    assert.match(replay.map((entry) => entry.text).join("\n"), /session restored/u);
    assert.match(replay.map((entry) => entry.text).join("\n"), /restored prompt/u);
  } finally {
    writer.dispose();
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testThreadEntryVariants(): Promise<void> {
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme();
  const entries: TranscriptEntry[] = [
    { kind: "system", persistence: "session", text: "system notice" },
    { kind: "user", persistence: "session", text: "unicode prompt 界🙂" },
    { kind: "assistant", persistence: "session", text: "# Answer\nRendered Markdown." },
    { kind: "reasoning", persistence: "display", text: "reasoning row" },
    {
      kind: "tool_call",
      persistence: "session",
      call: {
        tool: "edit_file",
        args: { path: "a.ts", edits: [{ old_text: "old", new_text: "new" }] },
      },
      label: "edit_file: a.ts",
      resultSummary: "updated",
      diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
    },
    { kind: "hook_status", persistence: "display", label: "hook>pre-tool-use: checking" },
    {
      kind: "permission_auto_approved",
      persistence: "session",
      permissionMode: "bash",
      approvalMode: "auto_allow",
      toolName: "bash",
      command: "pwd",
      workdir: "/repo",
      reason: "fixture",
      label: "auto-approved bash permission: pwd",
    },
    { kind: "subagent", persistence: "display", status: "event", sessionId: "child-session", text: "reading files" },
    {
      kind: "knowledge_status",
      persistence: "display",
      status: {
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: false,
        kbIsDirectory: false,
        cacheExists: false,
        cacheIsDirectory: false,
        kbPathSource: "default",
        cachePathSource: "default",
      },
      guidance: "Run /kb init",
    },
  ];
  const setup = await testRender(
    () => (
      <box width="100%" flexDirection="column">
        {entries.map((entry) => (
          <ThreadEntry entry={entry} theme={theme} syntaxStyle={syntaxStyle} />
        ))}
      </box>
    ),
    { width: 80, height: 60 }
  );

  try {
    await setup.renderOnce();
    await setup.flush();
    const frame = setup.captureCharFrame();
    for (const marker of [
      "system notice",
      "unicode prompt 界🙂",
      "Answer",
      "Rendered Markdown.",
      "reasoning row",
      "edit_file: a.ts updated",
      "hook>pre-tool-use: checking",
      "auto-approved bash permission: pwd",
      "reading files",
      "KB status: /repo/topchester-kb [missing]",
      "Run /kb init",
    ]) {
      assert.ok(frame.includes(marker), `missing transcript marker: ${marker}`);
    }
  } finally {
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testReasoningStyle(): Promise<void> {
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme();
  const entry = reasoningTranscriptEntry("thinking carefully\nsecond muted line");
  const setup = await testRender(() => <ThreadEntry entry={entry} theme={theme} syntaxStyle={syntaxStyle} />, {
    width: 80,
    height: 10,
  });

  try {
    await setup.renderOnce();
    const muted = RGBA.fromHex(theme.muted).toInts();
    const spans = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text.includes("thinking carefully") || span.text.includes("second muted line"));
    assert.equal(spans.length, 2);
    assert.ok(spans.every((span) => span.fg.toInts().every((value, index) => value === muted[index])));
  } finally {
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testAssistantMessage(): Promise<void> {
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme();
  const setup = await testRender(
    () => (
      <ThreadEntry
        entry={{ kind: "assistant", persistence: "session", text: "Done.", meta: "fixture-model" }}
        theme={theme}
        syntaxStyle={syntaxStyle}
      />
    ),
    { width: 80, height: 10 }
  );

  try {
    await setup.renderOnce();
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Done\./u);
    assert.match(setup.captureCharFrame(), /fixture-model/u);
  } finally {
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testNoColorSelection(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-no-color-"));
  const controller = await TopchesterTuiController.create(createTestContext(workspace), createRuntime());
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme({ noColor: true });
  controller.submitCommand("/connect");
  await controller.waitForIdle();
  const setup = await testRender(
    () => (
      <TopchesterApp
        controller={controller}
        initialSnapshot={controller.getSnapshot()}
        theme={theme}
        syntaxStyle={syntaxStyle}
        onInterrupt={() => {}}
      />
    ),
    { width: 80, height: 24 }
  );

  try {
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /❯ 1\) OpenRouter/u);
  } finally {
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testRenderFailureCleanup(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-error-"));
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "split-footer",
    exitSignals: [],
  });
  const failure = new Error("intentional renderer failure");
  let destroyed = false;
  setup.renderer.once("destroy", () => {
    destroyed = true;
  });
  setup.renderer.root.add = () => {
    throw failure;
  };
  const setBackgroundColor = setup.renderer.setBackgroundColor.bind(setup.renderer);
  let backgroundWasSet = false;
  setup.renderer.setBackgroundColor = (color) => {
    backgroundWasSet = true;
    setBackgroundColor(color);
  };
  const restoreStdinTty = overrideProperty(process.stdin, "isTTY", true);
  const restoreStdoutTty = overrideProperty(process.stdout, "isTTY", true);
  const signalCounts = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));

  try {
    await assert.rejects(
      runOpenTui(createTestContext(workspace), createRuntime(), {
        banner: "TOPCHESTER",
        rendererFactory: async () => setup.renderer,
      }),
      failure
    );
    assert.equal(destroyed, true);
    assert.deepEqual(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal)),
      signalCounts
    );
    assert.equal(backgroundWasSet, true);
  } finally {
    restoreStdinTty();
    restoreStdoutTty();
    if (!destroyed) setup.renderer.destroy();
  }
}

function overrideProperty(target: object, property: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, { configurable: true, value });
  return () => {
    if (previous) {
      Object.defineProperty(target, property, previous);
    } else {
      Reflect.deleteProperty(target, property);
    }
  };
}
