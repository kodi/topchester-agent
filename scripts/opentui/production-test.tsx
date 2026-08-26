/// <reference types="bun" />
/** @jsxImportSource @opentui/solid */

import {
  CliRenderEvents,
  RGBA,
  SyntaxStyle,
  TextAttributes,
  type CliRendererExternalOutputEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { render, testRender } from "@opentui/solid";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { agentEvent } from "../../src/agent/events.js";
import { type AgentRuntime } from "../../src/agent/runtime/index.js";
import { formatTuiSyncStatus } from "../../src/agent/runtime/knowledge.js";
import { TopchesterTuiController } from "../../src/chat/controller.js";
import { type TuiViewState } from "../../src/chat/controller-state.js";
import { reasoningTranscriptEntry, type ChoiceTranscriptEntry, type TranscriptEntry } from "../../src/chat/index.js";
import { formatKnowledgeCompileStatusResult } from "../../src/knowledge/compiler/index.js";
import { getKnowledgeStatus } from "../../src/knowledge/status.js";
import { createSession } from "../../src/session/store.js";
import { TopchesterApp } from "../../src/tui/opentui/app.js";
import { ThemeProvider } from "../../src/tui/opentui/context.js";
import { SessionPicker } from "../../src/tui/opentui/dialog-host.js";
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
await testQueuedFollowUpPreview();
await testTranscriptWriter();
await testThreadEntryVariants();
await testAssistantMessage();
await testReasoningStyle();
await testNoColorSelection();
await testTaskPlanUpdates();
await testChoiceDialogWrapping();
await testSessionPickerTitle();
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
  await controller.applyRuntimeEvents([agentEvent.knowledgeStatus(getKnowledgeStatus(workspace), "Run /kb init")]);
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
    const initialFrame = setup.captureCharFrame();
    assert.match(initialFrame, /Ask Topchester/u);
    assert.match(initialFrame, /not set/u);
    assert.deepEqual(composer.backgroundColor.toInts(), RGBA.fromHex(theme.background).toInts());
    const initialRows = initialFrame.split("\n");
    const promptRow = initialRows.findIndex((row) => row.includes("Ask Topchester"));
    assert.ok(promptRow > 0);
    assertPromptBorderSpansWidth(initialFrame, 80);
    assert.equal(initialRows[promptRow - 1]?.trim(), "");
    assert.equal(initialRows[promptRow + 1]?.trim(), "");
    const statusRow = initialRows.find((row) => row.includes("● ready"));
    assert.ok(statusRow, initialFrame);
    assert.ok(statusRow.includes(" topchester-opentui-app-"), statusRow);
    assert.ok(statusRow.trimEnd().endsWith("⚠ kb: missing"), statusRow);
    assert.ok((statusRow?.length ?? 0) - (statusRow?.trimEnd().length ?? 0) <= 1);

    controller.setNoticeLine("press Ctrl-C again to exit.");
    await setup.flush();
    const noticeRow = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("press Ctrl-C again to exit."));
    assert.ok(noticeRow, setup.captureCharFrame());
    assert.match(noticeRow, /^ ● ready · press Ctrl-C again to exit\./u);
    assert.doesNotMatch(noticeRow, /session|ctx|kb:/u);
    controller.setNoticeLine(undefined);
    await setup.flush();

    const singleLineHeight = composer.height;
    await setup.mockInput.typeText("first line");
    assert.equal(composer.newLine(), true);
    await setup.mockInput.typeText("second line");
    await setup.flush();
    assert.equal(composer.lineCount, 2);
    assert.equal(composer.height, singleLineHeight + 1);
    const multilineRows = setup.captureCharFrame().split("\n");
    const firstLineRow = multilineRows.findIndex((row) => row.includes("first line"));
    const secondLineRow = multilineRows.findIndex((row) => row.includes("second line"));
    assert.equal(secondLineRow, firstLineRow + 1);
    assert.equal(multilineRows[firstLineRow - 1]?.trim(), "");
    assert.equal(multilineRows[secondLineRow + 1]?.trim(), "");
    composer.setText("");
    await setup.flush();

    await setup.mockInput.typeText("/");
    await setup.flush();
    assert.ok(setup.renderer.footerHeight >= 10);
    assert.match(setup.captureCharFrame(), /\/context/u);
    assert.match(setup.captureCharFrame(), /\/compact/u);
    assert.match(setup.captureCharFrame(), /\/model all/u);

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
      const resizedFrame = setup.captureCharFrame();
      assert.match(resizedFrame, /not set/u);
      assertPromptBorderSpansWidth(resizedFrame, width);
    }
  } finally {
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

function assertPromptBorderSpansWidth(frame: string, width: number): void {
  const rows = frame.split("\n");
  const promptRow = rows.findIndex((row) => row.includes("Ask Topchester"));
  assert.ok(promptRow >= 2, frame);
  assert.equal(rows[promptRow - 2], "─".repeat(width));
}

async function testQueuedFollowUpPreview(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-queue-"));
  let releaseActiveTurn: () => void = () => {};
  let markActiveTurnStarted: () => void = () => {};
  const activeTurnStarted = new Promise<void>((resolve) => {
    markActiveTurnStarted = resolve;
  });
  const activeTurnBlocked = new Promise<void>((resolve) => {
    releaseActiveTurn = resolve;
  });
  const runtime = createRuntime();
  runtime.submitMessageStream = async function* (_conversation, message) {
    if (message === "active turn") {
      markActiveTurnStarted();
      await activeTurnBlocked;
    }
    yield agentEvent.assistantMessage("fixture answer", "model");
  };
  const controller = await TopchesterTuiController.create(createTestContext(workspace), runtime);
  const syntaxStyle = SyntaxStyle.create();
  const theme = resolveTopchesterTheme();
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
    { width: 80, height: 24, screenMode: "split-footer", footerHeight: 16, useMouse: false, exitOnCtrlC: false }
  );

  try {
    controller.submit("active turn");
    await activeTurnStarted;
    controller.submit(
      "Review the changes in every affected file and explain any compatibility concerns before finishing the task"
    );
    await setup.renderOnce();
    await setup.flush();

    const queuedFrame = setup.captureCharFrame();
    const queuedRow = queuedFrame.split("\n").find((row) => row.includes("[QUEUED]"));
    assert.ok(queuedRow, queuedFrame);
    assert.match(queuedRow, /^\s*\[QUEUED\] Review the changes/u);
    assert.match(queuedRow, /…/u);
    assert.doesNotMatch(queuedRow, /finishing the task/u);
    assert.match(queuedFrame, /queued: 1/u);

    releaseActiveTurn();
    await controller.waitForIdle();
    await setup.flush();
    assert.doesNotMatch(setup.captureCharFrame(), /\[QUEUED\]/u);
  } finally {
    releaseActiveTurn();
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
  const profile = { transcriptRecordsInspected: 0, transcriptRecordsSerialized: 0, scrollbackCommits: 0 };
  const writer = new TranscriptWriter(undefined, profile);

  try {
    writer.sync(setup.renderer, controller.getSnapshot(), theme, syntaxStyle);
    writer.sync(setup.renderer, controller.getSnapshot(), theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    const output = setup.externalOutput.take();
    assert.equal(output.length, 1);
    assert.match(output[0]?.text ?? "", /TOPCHESTER/u);
    assert.equal(profile.transcriptRecordsInspected, controller.getSnapshot().transcript.length);
    assert.equal(profile.transcriptRecordsSerialized, 0);

    const kbStatusText = formatKnowledgeCompileStatusResult(
      {
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbReady: true,
        gitignoreFiles: [],
        configIgnorePathCount: 0,
        files: [
          {
            path: ".github/workflows/publish-npm.yml",
            sizeBytes: 3816,
            hash: "sha256:changed",
            syncStatus: "changed",
          },
          {
            path: "skills/topchester/references/skills-hooks-sessions.md",
            sizeBytes: 509,
            hash: "sha256:missing",
            syncStatus: "missing_entry",
          },
        ],
      },
      { formatSyncStatus: formatTuiSyncStatus }
    ).join("\n");
    const kbStatusSnapshot = appendTranscriptSnapshot(controller.getSnapshot(), [
      { kind: "system", persistence: "session", text: kbStatusText } satisfies TranscriptEntry,
    ]);
    let changedColor: number[] | undefined;
    let fileIconColor: number[] | undefined;
    const captureKbStatusColors = (event: CliRendererExternalOutputEvent) => {
      const spans = event.snapshot.getSpanLines().flatMap((line) => line.spans);
      changedColor = spans.find((span) => span.text === "● changed")?.fg.toInts();
      fileIconColor = spans.find((span) => span.text === "▸")?.fg.toInts();
    };
    setup.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, captureKbStatusColors);
    try {
      writer.sync(setup.renderer, kbStatusSnapshot, theme, syntaxStyle);
      writer.sync(setup.renderer, kbStatusSnapshot, theme, syntaxStyle);
      await writer.idle();
      await setup.flush();
    } finally {
      setup.renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, captureKbStatusColors);
    }
    const kbStatusOutput = setup.externalOutput.take();
    assert.equal(kbStatusOutput.length, 1);
    const renderedKbStatus = kbStatusOutput[0]?.text ?? "";
    assert.match(renderedKbStatus, /● changed {2,}3816 bytes {2}▸ \.github\/workflows\/publish-npm\.yml/u);
    assert.match(
      renderedKbStatus,
      /○ missing_entry {2,}509 bytes {2}▸ skills\/topchester\/references\/skills-hooks-\nsessions\.md/u
    );
    assert.doesNotMatch(renderedKbStatus, /changedithub|missing_entrykills/u);

    assert.deepEqual(changedColor, RGBA.fromHex(theme.warning).toInts());
    assert.deepEqual(fileIconColor, RGBA.fromHex(theme.info).toInts());

    let keywordColor: number[] | undefined;
    let keywordBackground: number[] | undefined;
    let cssPropertyColor: number[] | undefined;
    let headingColor: number[] | undefined;
    let headingAttributes: number | undefined;
    let strongColor: number[] | undefined;
    let strongAttributes: number | undefined;
    let listStrongColor: number[] | undefined;
    let listStrongAttributes: number | undefined;
    const captureHighlight = (event: CliRendererExternalOutputEvent) => {
      const spans = event.snapshot.getSpanLines().flatMap((line) => line.spans);
      const keyword = spans.find((span) => span.text === "const");
      keywordColor = keyword?.fg.toInts();
      keywordBackground = keyword?.bg.toInts();
      cssPropertyColor = spans.find((span) => span.text === "color")?.fg.toInts();
      const heading = spans.find((span) => span.text === "YAML");
      headingColor = heading?.fg.toInts();
      headingAttributes = heading?.attributes;
      const strong = spans.find((span) => span.text === "color variants");
      strongColor = strong?.fg.toInts();
      strongAttributes = strong?.attributes;
      const listStrong = spans.find((span) => span.text === "Core React & Typescript API:");
      listStrongColor = listStrong?.fg.toInts();
      listStrongAttributes = listStrong?.attributes;
    };
    setup.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, captureHighlight);
    try {
      const markdownTranscript: TranscriptEntry[] = [
        {
          kind: "assistant",
          persistence: "session",
          text: [
            "Use **color variants** to override one item.",
            "",
            "* **Core React & Typescript API:** Components, hooks, custom slots...",
            "",
            "### YAML",
            "Define the server configuration:",
            "",
            "```yaml",
            "server:",
            "  port: 8080",
            "```",
            "",
            "### TSX",
            "Pass the variants to the component:",
            "",
            "```tsx",
            'import { Gantt } from "@antiflux/gantt";',
            "const answer: number = 42;",
            "<Gantt theme={customTheme} />",
            "```",
            "",
            "### CSS",
            "Style the custom chart:",
            "",
            "```css",
            ".custom-gantt { color: #ffffff; }",
            "```",
            "",
            "### Go",
            "Keep the final example separate:",
            "",
            "```go",
            "package main",
            "```",
          ].join("\n"),
        },
      ];
      const markdownSnapshot = appendTranscriptSnapshot(kbStatusSnapshot, markdownTranscript);
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
      "TSX",
      'import { Gantt } from "@antiflux/gantt";',
      "const answer: number = 42;",
      "<Gantt theme={customTheme} />",
      "CSS",
      ".custom-gantt { color: #ffffff; }",
      "Go",
      "package main",
    ]) {
      assert.ok(markdownText.includes(marker), `missing highlighted Markdown marker: ${marker}`);
    }
    assert.doesNotMatch(markdownText, /```|###/u);
    assert.match(markdownText, /^const answer: number = 42;[ \t]*$/mu);
    const markdownLines = markdownText.split("\n");
    assertCodeBlockPadding(markdownLines, "server:", "  port: 8080");
    assertCodeBlockPadding(markdownLines, 'import { Gantt } from "@antiflux/gantt";', "<Gantt theme={customTheme} />");
    assertCodeBlockPadding(markdownLines, ".custom-gantt { color: #ffffff; }", ".custom-gantt { color: #ffffff; }");
    assertCodeBlockPadding(markdownLines, "package main", "package main");
    assert.deepEqual(headingColor, RGBA.fromHex(theme.accent).toInts());
    assert.ok(((headingAttributes ?? 0) & TextAttributes.BOLD) !== 0);
    assert.deepEqual(strongColor, RGBA.fromHex(theme.emphasis).toInts());
    assert.ok(((strongAttributes ?? 0) & TextAttributes.BOLD) !== 0);
    assert.deepEqual(listStrongColor, RGBA.fromHex(theme.emphasis).toInts());
    assert.ok(((listStrongAttributes ?? 0) & TextAttributes.BOLD) !== 0);
    assert.deepEqual(keywordColor, RGBA.fromHex(theme.accent).toInts());
    assert.deepEqual(keywordBackground, RGBA.fromHex(theme.surface).toInts());
    assert.deepEqual(cssPropertyColor, RGBA.fromHex(theme.warning).toInts());

    const restoredSnapshot = resetTranscriptSnapshot(controller.getSnapshot(), {
      sessionId: "restored-session",
      sessionEpoch: 1,
      transcript: [{ kind: "user", persistence: "session", text: "restored prompt" }],
    });
    let terminalClearCount = 0;
    setup.renderer.resetSplitFooterForReplay = (options) => {
      terminalClearCount += 1;
      assert.deepEqual(options, { clearSavedLines: true });
    };
    writer.sync(setup.renderer, restoredSnapshot, theme, syntaxStyle);
    writer.sync(setup.renderer, restoredSnapshot, theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    const replay = setup.externalOutput.take();
    assert.equal(replay.length, 2);
    assert.match(replay.map((entry) => entry.text).join("\n"), /session restored/u);
    assert.match(replay.map((entry) => entry.text).join("\n"), /restored prompt/u);

    assert.equal(terminalClearCount, 0);

    const clearedSnapshot = resetTranscriptSnapshot(restoredSnapshot, {
      sessionId: "cleared-session",
      sessionEpoch: 2,
      transcript: [{ kind: "user", persistence: "session", text: "fresh after clear" }],
      clearTerminal: true,
    });
    writer.sync(setup.renderer, clearedSnapshot, theme, syntaxStyle);
    writer.sync(setup.renderer, clearedSnapshot, theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    const clearedOutput = setup.externalOutput.take();
    assert.equal(terminalClearCount, 1);
    assert.equal(clearedOutput.length, 2);
    assert.match(clearedOutput.map((entry) => entry.text).join("\n"), /session cleared/u);
    assert.match(clearedOutput.map((entry) => entry.text).join("\n"), /fresh after clear/u);

    const pendingWriter = new TranscriptWriter();
    const staleSnapshot = resetTranscriptSnapshot(restoredSnapshot, {
      sessionId: "stale-session",
      sessionEpoch: 10,
      transcript: [{ kind: "assistant", persistence: "session", text: "must not commit" }],
    });
    const freshSnapshot = resetTranscriptSnapshot(staleSnapshot, {
      sessionId: "fresh-session",
      sessionEpoch: 11,
      transcript: [{ kind: "assistant", persistence: "session", text: "fresh commit" }],
    });
    pendingWriter.sync(setup.renderer, staleSnapshot, theme, syntaxStyle);
    pendingWriter.sync(setup.renderer, freshSnapshot, theme, syntaxStyle);
    await pendingWriter.idle();
    await setup.flush();
    const pendingReset = setup.externalOutput.take();
    assert.equal(pendingReset.length, 2);
    assert.doesNotMatch(pendingReset.map((entry) => entry.text).join("\n"), /must not commit/u);
    assert.match(pendingReset.map((entry) => entry.text).join("\n"), /fresh commit/u);
    pendingWriter.dispose();

    const choiceWriter = new TranscriptWriter();
    const choiceSnapshot = resetTranscriptSnapshot(restoredSnapshot, {
      sessionId: "choice-session",
      sessionEpoch: 20,
      transcript: [
        {
          kind: "choice",
          persistence: "session",
          tone: "info",
          title: "Do not commit this choice",
          actions: [{ label: "Continue" }],
        },
      ],
    });
    choiceWriter.sync(setup.renderer, choiceSnapshot, theme, syntaxStyle);
    choiceWriter.sync(
      setup.renderer,
      appendTranscriptSnapshot(choiceSnapshot, [
        { kind: "assistant", persistence: "session", text: "stable after choice" },
      ]),
      theme,
      syntaxStyle
    );
    await choiceWriter.idle();
    await setup.flush();
    const choiceOutput = setup.externalOutput.take();
    assert.equal(choiceOutput.length, 1);
    assert.doesNotMatch(choiceOutput[0]?.text ?? "", /Do not commit this choice/u);
    assert.match(choiceOutput[0]?.text ?? "", /stable after choice/u);
    choiceWriter.dispose();
  } finally {
    writer.dispose();
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

function assertCodeBlockPadding(lines: readonly string[], firstLine: string, lastLine: string): void {
  const start = lines.findIndex((line) => line.trimEnd() === firstLine);
  const end = lines.findIndex((line, index) => index >= start && line.trimEnd() === lastLine);
  assert.ok(start > 0, `missing code block start: ${firstLine}`);
  assert.ok(end >= start && end + 1 < lines.length, `missing code block end: ${lastLine}`);
  assert.equal(lines[start - 1]?.trim(), "", `code block must have a blank row above: ${firstLine}`);
  assert.equal(lines[end + 1]?.trim(), "", `code block must have a blank row below: ${lastLine}`);
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
      "KB: missing",
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

async function testTaskPlanUpdates(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-plan-"));
  const theme = resolveTopchesterTheme();
  const syntaxStyle = SyntaxStyle.create();
  const session = await createSession(workspace);
  const controller = await TopchesterTuiController.create(createTestContext(workspace), createRuntime(), { session });
  const terminalOutput: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      terminalOutput.push(Buffer.from(chunk));
      callback();
    },
  }) as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: true, getColorDepth: () => 24 });
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 16,
    externalOutputMode: "capture-stdout",
    stdout,
    bufferedOutput: "stdout",
  });

  try {
    // The corruption only appears when plan updates share the production
    // split-footer path with scrollback commits and changing transient rows.
    await setup.renderer.setupTerminal();
    await setup.mockInput.pressKeys(["\u001b[24;1R"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await render(
      () => (
        <TopchesterApp
          controller={controller}
          initialSnapshot={controller.getSnapshot()}
          theme={theme}
          syntaxStyle={syntaxStyle}
          renderer={setup.renderer}
          onInterrupt={() => {}}
        />
      ),
      setup.renderer
    );
    await setup.renderOnce();
    const initialItems = [
      { text: "Count the number of lines in src", status: "in_progress" as const },
      { text: "Count one-line comments in src", status: "pending" as const },
      { text: "Summarize the counts", status: "pending" as const },
    ];
    await controller.applyRuntimeEvents([
      agentEvent.hookStatus("PreToolUse", "Correcting typo and creating plan"),
      agentEvent.toolCall({ tool: "plan_todo", args: { items: initialItems } }, "plan_todo: 3 items, 1 active"),
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:00.000Z",
        items: initialItems,
      }),
    ]);
    await setup.flush();
    await new Promise((resolve) => setTimeout(resolve, 75));
    await setup.flush();
    const initialFooterHeight = setup.renderer.footerHeight;
    terminalOutput.length = 0;
    assertPlanRows(setup.captureCharFrame(), [
      "◐ Count the number of lines in src",
      "○ Count one-line comments in src",
      "○ Summarize the counts",
    ]);

    await controller.applyRuntimeEvents([
      agentEvent.hookStatus(
        "PreToolUse",
        "Correcting typo and creating plan\nPlanning source line and comment counting\nPlanning line count with bash pipeline"
      ),
    ]);
    await setup.flush();
    assert.equal(
      setup.renderer.footerHeight,
      initialFooterHeight,
      "active task plans must reserve transient rows so status updates do not relocate the footer"
    );
    terminalOutput.length = 0;
    const updatedItems = [
      { text: "Count the number of lines in src", status: "completed" as const },
      { text: "Count one-line comments in src", status: "in_progress" as const },
      { text: "Summarize the counts", status: "pending" as const },
    ];
    await controller.applyRuntimeEvents([
      agentEvent.toolCall({ tool: "plan_todo", args: { items: updatedItems } }, "plan_todo: 3 items, 1 active"),
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:01.000Z",
        items: updatedItems,
      }),
    ]);
    await setup.flush();
    const updatedTerminalOutput = Buffer.concat(terminalOutput).toString("utf8");
    assert.match(updatedTerminalOutput, /✓ Count the number of lines in src/u);
    assert.match(updatedTerminalOutput, /◐ Count one-line comments in src/u);
    assertPlanRows(setup.captureCharFrame(), [
      "✓ Count the number of lines in src",
      "◐ Count one-line comments in src",
      "○ Summarize the counts",
    ]);

    const completedItems = [
      { text: "Count the number of lines in src", status: "completed" as const },
      { text: "Count one-line comments in src", status: "completed" as const },
      { text: "Summarize the results", status: "completed" as const },
    ];
    await controller.applyRuntimeEvents([
      agentEvent.toolCall({ tool: "plan_todo", args: { items: completedItems } }, "plan_todo: 3 items, 0 active"),
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:02.000Z",
        items: completedItems,
      }),
    ]);
    await setup.flush();
    assert.equal(setup.renderer.footerHeight, initialFooterHeight);
    assertPlanRows(setup.captureCharFrame(), [
      "✓ Count the number of lines in src",
      "✓ Count one-line comments in src",
      "✓ Summarize the results",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 75));
    await setup.flush();
    const settledFrame = setup.captureCharFrame();
    assertPlanRows(settledFrame, [
      "✓ Count the number of lines in src",
      "✓ Count one-line comments in src",
      "✓ Summarize the results",
    ]);
  } finally {
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testChoiceDialogWrapping(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-choice-"));
  const theme = resolveTopchesterTheme();
  const syntaxStyle = SyntaxStyle.create();
  const choice: ChoiceTranscriptEntry = {
    kind: "choice",
    persistence: "session",
    tone: "warning",
    title: "Run bash command?",
    body: [
      "Command:",
      "total=$(find src -type f -print0 | xargs -0 wc -l | tail -n 1 | awk '{print $1}'); comments=$(find src -type f -print0 | xargs -0 grep -hE '^[[:space:]]*//' | wc -l | awk '{print $1}'); awk -v total=\"$total\" -v comments=\"$comments\" 'BEGIN { printf \"total_lines=%d\\none_line_comments=%d\\ncomment_rate=%.4f%%\\n\", total, comments, (comments/total)*100 }'",
      "",
      "This bash command is not allowed yet.",
    ].join("\n"),
    actions: [
      { label: "Run once", value: "run_once" },
      { label: "Always allow exact command this session", value: "allow_session" },
      { label: "Always allow exact command for this repo", value: "allow_repo" },
      { label: "Cancel", value: "cancel" },
    ],
  };
  const controller = await TopchesterTuiController.create(createTestContext(workspace), createRuntime(), {
    initialTranscript: [choice],
  });
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
    { width: 120, height: 30, screenMode: "split-footer", footerHeight: 16 }
  );

  try {
    await setup.renderOnce();
    await setup.flush();
    setup.mockInput.pressArrow("down");
    await setup.flush();
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    const reasonRow = rows.findIndex((row) => row.includes("This bash command is not allowed yet."));
    const firstActionRow = rows.findIndex((row) => row.includes("  1) Run once"));
    assert.ok(reasonRow >= 0, frame);
    assert.ok(firstActionRow > reasonRow, frame);
  } finally {
    await controller.dispose();
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

async function testSessionPickerTitle(): Promise<void> {
  const theme = resolveTopchesterTheme();
  const setup = await testRender(
    () => (
      <ThemeProvider theme={theme}>
        <SessionPicker
          picker={{
            items: [
              {
                sessionId: "01900000-0000-7000-8000-000000000000",
                createdAt: "2026-07-17T00:00:00.000Z",
                updatedAt: "2026-07-17T00:00:00.000Z",
                title: "Short stored title",
                firstUserPrompt: "The full first prompt should not appear in the picker row",
              },
            ],
          }}
          selectedIndex={0}
        />
      </ThemeProvider>
    ),
    { width: 100, height: 10 }
  );

  try {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /Short stored title/u);
    assert.doesNotMatch(frame, /The full first prompt/u);
  } finally {
    setup.renderer.destroy();
  }
}

function assertPlanRows(frame: string, expectedRows: string[]): void {
  const rows = frame.split("\n");
  for (const expected of expectedRows) {
    assert.ok(
      rows.some((row) => row.includes(expected)),
      `missing intact task-plan row: ${expected}\n\n${frame}`
    );
  }
}

function appendTranscriptSnapshot(snapshot: TuiViewState, entries: readonly TranscriptEntry[]): TuiViewState {
  const firstId = snapshot.transcriptRecords.at(-1)?.id ?? -1;
  const records = entries.map((entry, index) => ({
    sessionEpoch: snapshot.sessionEpoch,
    id: firstId + index + 1,
    entry,
  }));
  return {
    ...snapshot,
    transcript: [...snapshot.transcript, ...entries],
    transcriptRecords: [...snapshot.transcriptRecords, ...records],
    transcriptChange: { kind: "append", sessionEpoch: snapshot.sessionEpoch, records },
  };
}

function resetTranscriptSnapshot(
  snapshot: TuiViewState,
  options: {
    sessionId: string;
    sessionEpoch: number;
    transcript: readonly TranscriptEntry[];
    clearTerminal?: boolean;
  }
): TuiViewState {
  const records = options.transcript.map((entry, id) => ({ sessionEpoch: options.sessionEpoch, id, entry }));
  return {
    ...snapshot,
    sessionId: options.sessionId,
    sessionEpoch: options.sessionEpoch,
    ...(options.clearTerminal ? { clearTerminalEpoch: options.sessionEpoch } : { clearTerminalEpoch: undefined }),
    transcript: [...options.transcript],
    transcriptRecords: records,
    transcriptChange: { kind: "reset", sessionEpoch: options.sessionEpoch, records },
  };
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
