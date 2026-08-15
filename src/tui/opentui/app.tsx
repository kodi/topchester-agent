/** @jsxImportSource @opentui/solid */

import { type CliRenderer, type SyntaxStyle } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import { type TopchesterTuiController } from "../../chat/controller.js";
import { type TuiViewState } from "../../chat/controller-state.js";
import { type FileMentionProvider } from "../file-mention-provider.js";
import { ControllerProvider, ThemeProvider } from "./context.js";
import { LiveFooter } from "./live-footer.js";
import { type TopchesterTheme } from "./theme.js";
import { TranscriptWriter } from "./transcript-writer.js";

export interface TopchesterAppProps {
  controller: TopchesterTuiController;
  initialSnapshot: TuiViewState;
  theme: TopchesterTheme;
  syntaxStyle: SyntaxStyle;
  renderer?: CliRenderer;
  mentionProvider?: FileMentionProvider;
  onRenderError?(error: unknown): void;
  onInterrupt(): void;
}

export function TopchesterApp(props: TopchesterAppProps) {
  const [snapshot, setSnapshot] = createSignal(props.initialSnapshot);
  const writer = new TranscriptWriter((error) => props.onRenderError?.(error));
  const syncWriter = (next: TuiViewState) => {
    if (props.renderer) {
      writer.sync(props.renderer, next, props.theme, props.syntaxStyle);
    }
  };
  const unsubscribe = props.controller.subscribe((next) => {
    syncWriter(next);
    setSnapshot(next);
  });
  onMount(() => syncWriter(snapshot()));
  onCleanup(() => {
    unsubscribe();
    writer.dispose();
  });

  return (
    <ControllerProvider controller={props.controller} snapshot={snapshot}>
      <ThemeProvider theme={props.theme}>
        <LiveFooter mentionProvider={props.mentionProvider} onInterrupt={() => props.onInterrupt()} />
      </ThemeProvider>
    </ControllerProvider>
  );
}
