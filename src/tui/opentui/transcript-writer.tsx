/** @jsxImportSource @opentui/solid */

import { type BaseRenderable, type CliRenderer, type SyntaxStyle } from "@opentui/core";
import { _render, createComponent, RendererContext, type JSX } from "@opentui/solid";
import { type TuiViewState } from "../../chat/controller-state.js";
import { ThreadEntry } from "./thread-entry.js";
import { type TopchesterTheme } from "./theme.js";

const SolidRendererProvider = RendererContext.Provider as unknown as (props: {
  readonly value: CliRenderer;
  readonly children: JSX.Element;
}) => BaseRenderable;

const SCROLLBACK_SETTLE_TIMEOUT_MS = 15_000;

/** Optional, test-only measurement seam. Normal sessions do not collect counters. */
export interface TranscriptWriterProfile {
  transcriptRecordsInspected: number;
  transcriptRecordsSerialized: number;
  scrollbackCommits: number;
}

export class TranscriptWriter {
  private readonly scheduled = new Set<string>();
  private pending = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private lastSessionEpoch = -1;
  private disposed = false;

  constructor(
    private readonly onError?: (error: unknown) => void,
    private readonly profile?: TranscriptWriterProfile
  ) {}

  sync(renderer: CliRenderer, snapshot: TuiViewState, theme: TopchesterTheme, syntaxStyle: SyntaxStyle): void {
    if (this.disposed || this.failure) {
      return;
    }

    if (this.lastSessionEpoch !== snapshot.sessionEpoch) {
      if (this.lastSessionEpoch >= 0) {
        this.scheduleCommit(
          renderer,
          `boundary:${snapshot.sessionEpoch}`,
          {
            kind: "system",
            persistence: "session",
            text: `── session ${snapshot.sessionId.slice(0, 8)} ──`,
          },
          theme,
          syntaxStyle
        );
      }
      this.lastSessionEpoch = snapshot.sessionEpoch;
    }

    snapshot.transcript.forEach((entry, index) => {
      if (this.profile) this.profile.transcriptRecordsInspected += 1;
      if (entry.kind !== "choice") {
        if (this.profile) this.profile.transcriptRecordsSerialized += 1;
        this.scheduleCommit(
          renderer,
          `${snapshot.sessionEpoch}:${index}:${stableEntryKey(entry)}`,
          entry,
          theme,
          syntaxStyle
        );
      }
    });
  }

  async idle(): Promise<void> {
    for (;;) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) {
        break;
      }
    }
    if (this.failure) {
      throw this.failure.error;
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private scheduleCommit(
    renderer: CliRenderer,
    identity: string,
    entry: TuiViewState["transcript"][number],
    theme: TopchesterTheme,
    syntaxStyle: SyntaxStyle
  ): void {
    if (this.scheduled.has(identity)) {
      return;
    }
    this.scheduled.add(identity);
    this.pending = this.pending.then(async () => {
      if (this.disposed || this.failure) {
        return;
      }
      try {
        await this.commit(renderer, entry, theme, syntaxStyle);
      } catch (error) {
        if (!this.disposed) {
          this.reportFailure(error);
        }
      }
    });
  }

  private async commit(
    renderer: CliRenderer,
    entry: TuiViewState["transcript"][number],
    theme: TopchesterTheme,
    syntaxStyle: SyntaxStyle
  ): Promise<void> {
    const surface = renderer.createScrollbackSurface({ startOnNewLine: true });
    let disposeSolid: (() => void) | undefined;

    try {
      disposeSolid = _render(
        () =>
          createComponent(SolidRendererProvider, {
            get value() {
              return surface.renderContext as CliRenderer;
            },
            get children() {
              return (
                <box width="100%" flexDirection="column" paddingBottom={1}>
                  <ThreadEntry entry={entry} theme={theme} syntaxStyle={syntaxStyle} />
                </box>
              );
            },
          }),
        surface.root
      );
      await surface.settle(SCROLLBACK_SETTLE_TIMEOUT_MS);
      if (!this.disposed) {
        surface.commitRows(0, surface.height, { trailingNewline: true });
        if (this.profile) this.profile.scrollbackCommits += 1;
      }
    } finally {
      if (!surface.isDestroyed) {
        surface.destroy();
      }
      disposeSolid?.();
    }
  }

  private reportFailure(error: unknown): void {
    if (this.failure) {
      return;
    }
    this.failure = { error };
    this.onError?.(error);
  }
}

function stableEntryKey(entry: TuiViewState["transcript"][number]): string {
  return JSON.stringify(entry);
}
