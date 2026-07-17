/** @jsxImportSource @opentui/solid */

import { type CliRenderer, type SyntaxStyle } from "@opentui/core";
import { writeSolidToScrollback } from "@opentui/solid";
import { type TuiViewState } from "../../chat/controller-state.js";
import { ThreadEntry } from "./thread-entry.js";
import { type TopchesterTheme } from "./theme.js";

export class TranscriptWriter {
  private readonly committed = new Set<string>();
  private lastSessionEpoch = -1;

  sync(renderer: CliRenderer, snapshot: TuiViewState, theme: TopchesterTheme, syntaxStyle: SyntaxStyle): void {
    if (this.lastSessionEpoch !== snapshot.sessionEpoch) {
      if (this.lastSessionEpoch >= 0) {
        this.commit(
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
      if (entry.kind !== "choice") {
        this.commit(renderer, `${snapshot.sessionEpoch}:${index}:${stableEntryKey(entry)}`, entry, theme, syntaxStyle);
      }
    });
  }

  private commit(
    renderer: CliRenderer,
    identity: string,
    entry: TuiViewState["transcript"][number],
    theme: TopchesterTheme,
    syntaxStyle: SyntaxStyle
  ): void {
    if (this.committed.has(identity)) {
      return;
    }
    writeSolidToScrollback(
      renderer,
      () => (
        <box width="100%" flexDirection="column" paddingBottom={1}>
          <ThreadEntry entry={entry} theme={theme} syntaxStyle={syntaxStyle} />
        </box>
      ),
      { startOnNewLine: true, trailingNewline: true }
    );
    this.committed.add(identity);
  }
}

function stableEntryKey(entry: TuiViewState["transcript"][number]): string {
  return JSON.stringify(entry);
}
