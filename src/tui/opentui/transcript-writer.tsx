/** @jsxImportSource @opentui/solid */

import { type BaseRenderable, type CliRenderer, type SyntaxStyle } from "@opentui/core";
import { _render, createComponent, RendererContext, type JSX } from "@opentui/solid";
import { type TuiTranscriptRecord, type TuiViewState } from "../../chat/controller-state.js";
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

export interface TranscriptAppendCursorResult {
  readonly sessionChanged: boolean;
  readonly sessionEpoch: number;
  readonly records: readonly TuiTranscriptRecord[];
}

export class TranscriptAppendCursor {
  private sessionEpoch = -1;
  private appendCursor = 0;

  constructor(private readonly profile?: Pick<TranscriptWriterProfile, "transcriptRecordsInspected">) {}

  sync(snapshot: TuiViewState): TranscriptAppendCursorResult {
    const previousEpoch = this.sessionEpoch;
    const epochChanged = previousEpoch !== snapshot.sessionEpoch;
    if (epochChanged) {
      this.sessionEpoch = snapshot.sessionEpoch;
      this.appendCursor = 0;
    }
    const candidates = epochChanged
      ? snapshot.transcriptRecords
      : snapshot.transcriptChange.kind === "append"
        ? snapshot.transcriptChange.records
        : [];
    const records: TuiTranscriptRecord[] = [];
    for (const record of candidates) {
      if (record.sessionEpoch !== this.sessionEpoch || record.id < this.appendCursor) {
        continue;
      }
      if (this.profile) this.profile.transcriptRecordsInspected += 1;
      this.appendCursor = record.id + 1;
      if (record.entry.kind !== "choice") {
        records.push(record);
      }
    }
    return {
      sessionChanged: previousEpoch >= 0 && epochChanged,
      sessionEpoch: this.sessionEpoch,
      records,
    };
  }
}

export class TranscriptWriter {
  private pending = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private readonly cursor: TranscriptAppendCursor;
  private sessionEpoch = -1;
  private disposed = false;

  constructor(
    private readonly onError?: (error: unknown) => void,
    private readonly profile?: TranscriptWriterProfile
  ) {
    this.cursor = new TranscriptAppendCursor(profile);
  }

  sync(renderer: CliRenderer, snapshot: TuiViewState, theme: TopchesterTheme, syntaxStyle: SyntaxStyle): void {
    if (this.disposed || this.failure) {
      return;
    }

    const update = this.cursor.sync(snapshot);
    this.sessionEpoch = update.sessionEpoch;
    if (update.sessionChanged) {
      this.scheduleCommit(
        renderer,
        update.sessionEpoch,
        {
          kind: "system",
          persistence: "session",
          text: `── session ${snapshot.sessionId.slice(0, 8)} ──`,
        },
        theme,
        syntaxStyle
      );
    }
    for (const record of update.records) {
      this.scheduleCommit(renderer, update.sessionEpoch, record.entry, theme, syntaxStyle);
    }
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
    sessionEpoch: number,
    entry: TuiViewState["transcript"][number],
    theme: TopchesterTheme,
    syntaxStyle: SyntaxStyle
  ): void {
    this.pending = this.pending.then(async () => {
      if (this.disposed || this.failure || sessionEpoch !== this.sessionEpoch) {
        return;
      }
      try {
        await this.commit(renderer, sessionEpoch, entry, theme, syntaxStyle);
      } catch (error) {
        if (!this.disposed && sessionEpoch === this.sessionEpoch) {
          this.reportFailure(error);
        }
      }
    });
  }

  private async commit(
    renderer: CliRenderer,
    sessionEpoch: number,
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
      if (!this.disposed && sessionEpoch === this.sessionEpoch) {
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
