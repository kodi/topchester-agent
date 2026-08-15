/** @jsxImportSource @opentui/solid */

import { SyntaxStyle, type CliRendererStats } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { ChoiceDialog } from "../../src/tui/opentui/dialog-host.js";
import { ThemeProvider } from "../../src/tui/opentui/context.js";
import { resolveTopchesterTheme } from "../../src/tui/opentui/theme.js";
import { TranscriptWriter } from "../../src/tui/opentui/transcript-writer.js";
import { TuiViewStore } from "../../src/chat/controller-state.js";
import type { ScenarioName } from "./performance.js";

export interface RendererScenarioResult {
  readonly counters: Record<string, number>;
  readonly native: {
    readonly frameTimeMs: { p50: number; p95: number; p99: number; max: number } | "unsupported";
    readonly renderTimeMs: number | "unsupported";
    readonly stdoutWriteTimeMs: number | "unsupported";
    readonly frames: number;
    readonly updatedCells: number;
  };
}

export async function runRendererScenario(
  name: Extract<ScenarioName, "scrollback-heavy-entry" | "resize-and-dialog">
): Promise<RendererScenarioResult> {
  const theme = resolveTopchesterTheme();
  const setup = await testRender(
    () =>
      name === "resize-and-dialog" ? (
        <ThemeProvider theme={theme}>
          <ChoiceDialog
            choice={{
              kind: "choice",
              persistence: "session",
              tone: "info",
              title: "Performance dialog",
              actions: [{ label: "Continue" }],
            }}
            selectedIndex={0}
          />
        </ThemeProvider>
      ) : (
        <box />
      ),
    {
      width: 80,
      height: 24,
      screenMode: "split-footer",
      externalOutputMode: "capture-stdout",
      gatherStats: true,
    }
  );
  const syntaxStyle = SyntaxStyle.create();
  try {
    await setup.renderOnce();
    if (name === "resize-and-dialog") {
      for (const [width, height] of [
        [80, 24],
        [120, 40],
        [200, 60],
      ] as const) {
        setup.resize(width, height);
        await setup.flush();
      }
      return {
        counters: { resizes: 3, terminalSizes: 3, dialogActivations: 1, dropped: 0, duplicated: 0, reordered: 0 },
        native: nativeStats(setup.renderer.getStats()),
      };
    }
    const profile = { transcriptRecordsInspected: 0, transcriptRecordsSerialized: 0, scrollbackCommits: 0 };
    const writer = new TranscriptWriter(undefined, profile);
    const view = new TuiViewStore({
      sessionId: "00000000-0000-7000-8000-000000000000",
      workspaceLabel: "fixture",
      modelLabel: "fixture",
      transcript: [
        { kind: "assistant", persistence: "session", text: "# fixture\n```ts\nconst value = 1;\n```" },
        { kind: "assistant", persistence: "session", text: "```diff\n+ fixture\n```" },
        { kind: "assistant", persistence: "session", text: "## fixture" },
      ],
    });
    writer.sync(setup.renderer, view.getSnapshot(), theme, syntaxStyle);
    await writer.idle();
    await setup.flush();
    return {
      counters: {
        markdownEntries: 3,
        fencedCodeBlocks: 2,
        diffEntries: 1,
        ...profile,
        dropped: 0,
        duplicated: 0,
        reordered: 0,
      },
      native: nativeStats(setup.renderer.getStats()),
    };
  } finally {
    setup.renderer.destroy();
    syntaxStyle.destroy();
  }
}

function nativeStats(stats: CliRendererStats): RendererScenarioResult["native"] {
  const frameTimes = stats.frameTimes.filter((value) => Number.isFinite(value));
  const percentile = (requested: number) => {
    const sorted = [...frameTimes].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil((requested / 100) * sorted.length) - 1)] ?? 0;
  };
  return {
    frameTimeMs:
      frameTimes.length === 0
        ? "unsupported"
        : { p50: percentile(50), p95: percentile(95), p99: percentile(99), max: percentile(100) },
    renderTimeMs: stats.nativeRenderTime ?? "unsupported",
    stdoutWriteTimeMs: stats.nativeStdoutWriteTime ?? "unsupported",
    frames: stats.frameCount,
    updatedCells: stats.cellsUpdated,
  };
}
