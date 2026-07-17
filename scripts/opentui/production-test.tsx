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
import { formatTuiSyncStatus } from "../../src/agent/runtime/knowledge.js";
import { TopchesterTuiController } from "../../src/chat/controller.js";
import { reasoningTranscriptEntry, type ChoiceTranscriptEntry, type TranscriptEntry } from "../../src/chat/index.js";
import { formatKnowledgeCompileStatusResult } from "../../src/knowledge/compiler/index.js";
import { getKnowledgeStatus } from "../../src/knowledge/status.js";
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
    assert.equal(initialRows[promptRow - 1]?.trim(), "");
    assert.equal(initialRows[promptRow + 1]?.trim(), "");
    const statusRow = initialRows.find((row) => row.includes("● ready"));
    assert.ok(statusRow, initialFrame);
    assert.ok(statusRow.includes(" topchester-opentui-app-"), statusRow);
    assert.ok(statusRow.trimEnd().endsWith("⚠ kb: missing"), statusRow);
    assert.ok((statusRow?.length ?? 0) - (statusRow?.trimEnd().length ?? 0) <= 1);

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
    const kbStatusSnapshot = {
      ...controller.getSnapshot(),
      transcript: [{ kind: "system", persistence: "session", text: kbStatusText } satisfies TranscriptEntry],
    };
    writer.sync(setup.renderer, kbStatusSnapshot, theme, syntaxStyle);
    writer.sync(setup.renderer, kbStatusSnapshot, theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    const kbStatusOutput = setup.externalOutput.take();
    assert.equal(kbStatusOutput.length, 1);
    const renderedKbStatus = kbStatusOutput[0]?.text ?? "";
    assert.match(renderedKbStatus, /changed {2,}3816 bytes {2}\.github\/workflows\/publish-npm\.yml/u);
    assert.match(
      renderedKbStatus,
      /missing_entry {2,}509 bytes {2}skills\/topchester\/references\/skills-hooks-sessions\.md/u
    );
    assert.doesNotMatch(renderedKbStatus, /changedithub|missing_entrykills/u);

    let keywordColor: number[] | undefined;
    let keywordBackground: number[] | undefined;
    const captureHighlight = (event: CliRendererExternalOutputEvent) => {
      const keyword = event.snapshot
        .getSpanLines()
        .flatMap((line) => line.spans)
        .find((span) => span.text === "const");
      keywordColor = keyword?.fg.toInts();
      keywordBackground = keyword?.bg.toInts();
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
    assert.match(markdownText, /^const answer: number = 42;[ \t]*$/mu);
    assert.deepEqual(keywordColor, RGBA.fromHex(theme.accent).toInts());
    assert.deepEqual(keywordBackground, RGBA.fromHex(theme.surface).toInts());

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

async function testTaskPlanUpdates(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-plan-"));
  const theme = resolveTopchesterTheme();
  const syntaxStyle = SyntaxStyle.create();
  const controller = await TopchesterTuiController.create(createTestContext(workspace), createRuntime());
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
    { width: 80, height: 24, screenMode: "split-footer", footerHeight: 16 }
  );

  try {
    await setup.renderOnce();
    await controller.applyRuntimeEvents([
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:00.000Z",
        items: [
          { text: "Count the total number of lines in src", status: "in_progress" },
          { text: "Count one-line comments in src", status: "pending" },
          { text: "Summarize the results", status: "pending" },
        ],
      }),
    ]);
    await setup.flush();
    assertPlanRows(setup.captureCharFrame(), [
      "◐ Count the total number of lines in src",
      "○ Count one-line comments in src",
      "○ Summarize the results",
    ]);

    await controller.applyRuntimeEvents([
      agentEvent.taskPlan({
        updatedAt: "2026-07-17T00:00:01.000Z",
        items: [
          { text: "Count the number of one-line comments in src", status: "in_progress" },
          { text: "Summarize the results", status: "pending" },
        ],
      }),
    ]);
    await setup.flush();
    assertPlanRows(setup.captureCharFrame(), [
      "◐ Count the number of one-line comments in src",
      "○ Summarize the results",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 75));
    await setup.flush();
    const settledFrame = setup.captureCharFrame();
    assertPlanRows(settledFrame, ["◐ Count the number of one-line comments in src", "○ Summarize the results"]);
    assert.doesNotMatch(settledFrame, /Count the total number of lines/u);
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
