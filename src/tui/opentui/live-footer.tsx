/** @jsxImportSource @opentui/solid */

import { type KeyEvent, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type TuiViewState } from "../../chat/controller-state.js";
import { getSlashCommandSuggestions, type SlashCommandSuggestion } from "../../chat/suggestions.js";
import { type ChoiceTranscriptEntry } from "../../chat/transcript.js";
import { applyMentionCompletion, findActiveMention } from "../file-mentions.js";
import { type FileMentionProvider, type FileMentionSuggestion } from "../file-mention-provider.js";
import { ComposerState } from "./composer-state.js";
import { useController, useTheme } from "./context.js";
import { ChoiceDialog, SessionPicker } from "./dialog-host.js";
import { StatusBar } from "./status-bar.js";
import { SuggestionList } from "./suggestion-list.js";
import { TaskPlan } from "./task-plan.js";

type VisibleSuggestion =
  | { kind: "mention"; label: string; mention: FileMentionSuggestion }
  | { kind: "slash"; label: string; slash: SlashCommandSuggestion };

const TASK_PLAN_RESERVED_TRANSIENT_ROWS = 4;

export function LiveFooter(props: { mentionProvider?: FileMentionProvider; onInterrupt(): void }) {
  const { controller, snapshot } = useController();
  const theme = useTheme();
  const renderer = useRenderer();
  const renderDimensions = useTerminalDimensions();
  const composerState = new ComposerState();
  const [draft, setDraft] = createSignal("");
  const [selection, setSelection] = createSignal(0);
  const [cursorVersion, setCursorVersion] = createSignal(0);
  const [dismissedMentionKey, setDismissedMentionKey] = createSignal<string>();
  let composer: TextareaRenderable | undefined;
  let previousSessionEpoch = snapshot().sessionEpoch;
  let footerShrinkTimer: ReturnType<typeof setTimeout> | undefined;
  let desiredFooterHeight = renderer.footerHeight;

  const activeChoice = createMemo(() => {
    const entry = snapshot().transcript.at(-1);
    return entry?.kind === "choice" ? entry : undefined;
  });
  const activeMention = createMemo(() => {
    cursorVersion();
    return findActiveMention(draft(), composer?.cursorOffset ?? draft().length);
  });
  const activeMentionKey = createMemo(() => {
    const mention = activeMention();
    return mention ? `${mention.start}:${mention.end}:${mention.query}` : undefined;
  });
  const mentionSuggestions = createMemo(() => {
    const mention = activeMention();
    if (!mention || !props.mentionProvider || snapshot().promptHint || activeMentionKey() === dismissedMentionKey()) {
      return [];
    }
    return props.mentionProvider.getSuggestions(mention.query, 20);
  });
  const slashSuggestions = createMemo(() => (snapshot().promptHint ? [] : getSlashCommandSuggestions(draft())));
  const visibleSuggestions = createMemo<VisibleSuggestion[]>(() =>
    mentionSuggestions().length > 0
      ? mentionSuggestions().map((item) => ({
          kind: "mention",
          label: `@${item.path}${item.isDirectory ? "/" : ""}`,
          mention: item,
        }))
      : slashSuggestions().map((item) => ({
          kind: "slash",
          label: `${item.value}  ${item.description}`,
          slash: item,
        }))
  );
  const hasOverlay = createMemo(() => activeChoice() !== undefined || snapshot().sessionPicker !== undefined);
  const selectionContext = createMemo(
    () =>
      `${activeChoice()?.title ?? ""}\0${snapshot().sessionPicker?.items.length ?? 0}\0${draft()}\0${visibleSuggestions()
        .map((item) => item.label)
        .join("\0")}`
  );

  createEffect(() => {
    selectionContext();
    setSelection(0);
  });

  createEffect(() => {
    const epoch = snapshot().sessionEpoch;
    if (epoch === previousSessionEpoch) {
      return;
    }
    previousSessionEpoch = epoch;
    composerState.resetSession();
    composer?.setText("");
    setDraft("");
    setDismissedMentionKey(undefined);
  });

  createEffect(() => {
    if (hasOverlay() || snapshot().promptHint) {
      composer?.blur();
    } else {
      composer?.focus();
    }
  });

  createEffect(() => {
    // In split-footer mode, useTerminalDimensions() reports the live footer
    // surface rather than the physical terminal. Keep the hook as the resize
    // signal, but use the renderer's terminal height when bounding the footer;
    // otherwise each footer-height update feeds a smaller height back into this
    // effect until dialogs and suggestions collapse to the six-row minimum.
    renderDimensions();
    const height = renderer.terminalHeight;
    const width = renderer.terminalWidth;
    const next = estimateFooterHeight(snapshot(), activeChoice(), visibleSuggestions().length, draft(), width);
    const footerHeight = Math.max(6, Math.min(Math.max(6, height - 2), next));
    desiredFooterHeight = footerHeight;
    if (footerShrinkTimer) {
      clearTimeout(footerShrinkTimer);
      footerShrinkTimer = undefined;
    }
    if (footerHeight >= renderer.footerHeight) {
      if (renderer.footerHeight !== footerHeight) renderer.footerHeight = footerHeight;
      return;
    }
    footerShrinkTimer = setTimeout(() => {
      footerShrinkTimer = undefined;
      if (renderer.footerHeight !== desiredFooterHeight) renderer.footerHeight = desiredFooterHeight;
    }, 50);
    footerShrinkTimer.unref?.();
  });

  onCleanup(() => {
    if (footerShrinkTimer) clearTimeout(footerShrinkTimer);
  });

  const consume = (event: KeyEvent | PasteEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const setComposerText = (value: string, cursor = value.length) => {
    composer?.setText(value);
    if (composer) {
      composer.cursorOffset = cursor;
    }
    setDraft(value);
    setCursorVersion((version) => version + 1);
  };

  const handleKey = (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      consume(event);
      props.onInterrupt();
      return;
    }

    const choice = activeChoice();
    if (choice) {
      handleChoiceKey(
        event,
        choice.actions.length,
        selection,
        setSelection,
        () => {
          const action = choice.actions[selection()];
          if (action) controller.choose(action);
        },
        () => controller.dismissDialog()
      );
      return;
    }

    const picker = snapshot().sessionPicker;
    if (picker) {
      handlePickerKey(
        event,
        picker.items.length,
        selection,
        setSelection,
        () => {
          const item = picker.items[selection()];
          if (item) controller.selectSession(item.sessionId);
        },
        () => controller.cancelSessionPicker(),
        renderer.terminalHeight
      );
      return;
    }

    const suggestions = visibleSuggestions();
    if (suggestions.length > 0 && (event.name === "up" || event.name === "down")) {
      consume(event);
      const delta = event.name === "up" ? -1 : 1;
      setSelection((selection() + delta + suggestions.length) % suggestions.length);
      return;
    }
    if (suggestions.length > 0 && (event.name === "tab" || event.name === "return")) {
      const selected = suggestions[selection()];
      if (selected?.kind === "slash") {
        if (event.name === "return" && draft().trim() === selected.slash.value) {
          return;
        }
        consume(event);
        setComposerText(selected.slash.value);
        composerState.resetHistoryBrowsing();
        return;
      }
      if (selected?.kind === "mention") {
        const mention = activeMention();
        if (mention) {
          consume(event);
          const completed = applyMentionCompletion(
            draft(),
            mention,
            selected.mention.path,
            selected.mention.isDirectory
          );
          setComposerText(completed.value, completed.cursor);
          setDismissedMentionKey(undefined);
          composerState.resetHistoryBrowsing();
        }
        return;
      }
    }
    if (event.name === "escape" && mentionSuggestions().length > 0) {
      consume(event);
      setDismissedMentionKey(activeMentionKey());
      return;
    }

    if (event.name === "escape" && snapshot().canCancel) {
      consume(event);
      controller.cancel();
      return;
    }

    if (snapshot().promptHint) {
      consume(event);
      return;
    }

    if (event.name === "up") {
      if ((composer?.cursorOffset ?? 0) === 0) {
        consume(event);
        const previous = composerState.previousHistory(draft());
        if (previous !== undefined) setComposerText(previous);
        return;
      }
      if (composer?.logicalCursor.row === 0) {
        consume(event);
        composer.cursorOffset = 0;
        setCursorVersion((version) => version + 1);
        return;
      }
    }

    if (event.name === "down") {
      if ((composer?.cursorOffset ?? 0) === draft().length) {
        consume(event);
        const next = composerState.nextHistory();
        if (next !== undefined) setComposerText(next);
        return;
      }
      if (composer && composer.logicalCursor.row === composer.lineCount - 1) {
        consume(event);
        composer.cursorOffset = draft().length;
        setCursorVersion((version) => version + 1);
        return;
      }
    }

    if (isEditingKey(event)) {
      composerState.resetHistoryBrowsing();
      setDismissedMentionKey(undefined);
    }
  };

  const handlePaste = (event: PasteEvent) => {
    if (hasOverlay() || snapshot().promptHint) {
      consume(event);
      return;
    }
    consume(event);
    const text = new TextDecoder().decode(event.bytes);
    const insertion = composerState.preparePaste(text);
    if (insertion) {
      composer?.insertText(insertion);
      setDraft(composer?.plainText ?? draft());
      setCursorVersion((version) => version + 1);
      composerState.resetHistoryBrowsing();
      setDismissedMentionKey(undefined);
    }
  };

  const submit = () => {
    const value = composerState.expandSubmission(composer?.plainText ?? "");
    if (!value || hasOverlay() || snapshot().promptHint) {
      return;
    }
    composerState.recordSubmission(value);
    setComposerText("");
    setDismissedMentionKey(undefined);
    if (value.startsWith("/")) {
      controller.submitCommand(value);
    } else {
      controller.submit(value);
    }
  };

  useKeyboard(handleKey);
  usePaste(handlePaste);
  onMount(() => composer?.focus());

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.background}
    >
      <Show when={snapshot().taskPlan}>{(plan) => <TaskPlan plan={plan()} />}</Show>
      <Show when={snapshot().startupHint}>
        {(line) => (
          <text width="100%" wrapMode="word" fg={theme.muted}>
            {line()}
          </text>
        )}
      </Show>
      <Show when={snapshot().ephemeral}>
        {(line) => (
          <text width="100%" wrapMode="word" fg={line().tone === "muted" ? theme.muted : theme.text}>
            {line().text}
          </text>
        )}
      </Show>
      <Show when={snapshot().temporaryLine}>
        {(line) => (
          <text width="100%" wrapMode="word" fg={theme.muted}>
            {line()}
          </text>
        )}
      </Show>
      <Show when={snapshot().taskPlanNotice}>
        {(line) => (
          <text width="100%" wrapMode="word" fg={theme.muted}>
            {line()}
          </text>
        )}
      </Show>
      <Show when={snapshot().sessionPicker}>
        {(picker) => <SessionPicker picker={picker()} selectedIndex={selection()} />}
      </Show>
      <Show when={activeChoice()}>{(choice) => <ChoiceDialog choice={choice()} selectedIndex={selection()} />}</Show>
      <Show when={!hasOverlay() && visibleSuggestions().length > 0}>
        <SuggestionList items={visibleSuggestions().map((item) => item.label)} selectedIndex={selection()} />
      </Show>
      <box border={["top"]} borderColor={theme.focus} flexDirection="column" minHeight={5}>
        <textarea
          id="topchester-composer"
          ref={(value) => {
            composer = value;
          }}
          width="100%"
          minHeight={1}
          maxHeight={5}
          marginTop={1}
          marginBottom={1}
          wrapMode="word"
          placeholder={snapshot().promptHint ?? "Ask Topchester…"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.background}
          focusedBackgroundColor={theme.background}
          placeholderColor={snapshot().promptHint ? theme.warning : theme.muted}
          cursorColor={theme.accent}
          selectionBg={theme.selection}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={submit}
          onCursorChange={() => setCursorVersion((version) => version + 1)}
          onContentChange={() => setDraft(composer?.plainText ?? "")}
        />
        <StatusBar />
      </box>
    </box>
  );
}

function handleChoiceKey(
  event: KeyEvent,
  itemCount: number,
  selection: () => number,
  setSelection: (value: number | ((current: number) => number)) => void,
  accept: () => void,
  cancel: () => void
): void {
  event.preventDefault();
  event.stopPropagation();
  if (itemCount > 0 && (event.name === "up" || event.name === "down")) {
    const delta = event.name === "up" ? -1 : 1;
    setSelection((selection() + delta + itemCount) % itemCount);
  } else if (event.name === "return") {
    accept();
  } else if (event.name === "escape") {
    cancel();
  }
}

function handlePickerKey(
  event: KeyEvent,
  itemCount: number,
  selection: () => number,
  setSelection: (value: number | ((current: number) => number)) => void,
  accept: () => void,
  cancel: () => void,
  terminalHeight: number
): void {
  event.preventDefault();
  event.stopPropagation();
  if (itemCount === 0) {
    if (event.name === "escape") cancel();
    return;
  }
  if (event.name === "up" || event.name === "down") {
    const delta = event.name === "up" ? -1 : 1;
    setSelection(Math.max(0, Math.min(itemCount - 1, selection() + delta)));
  } else if (event.name === "pageup" || event.name === "pagedown") {
    const delta = Math.max(1, Math.floor(terminalHeight / 2)) * (event.name === "pageup" ? -1 : 1);
    setSelection(Math.max(0, Math.min(itemCount - 1, selection() + delta)));
  } else if (event.name === "home") {
    setSelection(0);
  } else if (event.name === "end") {
    setSelection(itemCount - 1);
  } else if (event.name === "return") {
    accept();
  } else if (event.name === "escape") {
    cancel();
  }
}

function isEditingKey(event: KeyEvent): boolean {
  return (
    event.sequence.length > 0 || ["backspace", "delete", "return", "left", "right", "home", "end"].includes(event.name)
  );
}

function estimateFooterHeight(
  snapshot: TuiViewState,
  choice: ChoiceTranscriptEntry | undefined,
  suggestionCount: number,
  draft: string,
  terminalWidth: number
): number {
  const base = 6 + Math.min(4, Math.max(0, draft.split("\n").length - 1));
  const taskRows = Math.min(6, snapshot.taskPlan?.items.length ?? 0);
  const transientRows = [
    snapshot.startupHint,
    snapshot.ephemeral?.text,
    snapshot.temporaryLine,
    snapshot.taskPlanNotice,
  ]
    .filter(Boolean)
    .reduce((total, value) => total + Math.min(3, String(value).split("\n").length), 0);
  const stableTransientRows = snapshot.taskPlan
    ? Math.max(TASK_PLAN_RESERVED_TRANSIENT_ROWS, transientRows)
    : transientRows;
  const overlayRows = choice
    ? Math.min(8, choice.actions.length) + estimateWrappedRows(choice.body, Math.max(1, terminalWidth - 6)) + 3
    : snapshot.sessionPicker
      ? Math.min(7, snapshot.sessionPicker.items.length) + 3
      : Math.min(6, suggestionCount);
  return base + taskRows + stableTransientRows + overlayRows;
}

function estimateWrappedRows(text: string | undefined, width: number): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);
}
