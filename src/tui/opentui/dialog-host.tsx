/** @jsxImportSource @opentui/solid */

import { For, Show } from "solid-js";
import { type TuiViewState } from "../../chat/controller-state.js";
import { useTheme } from "./context.js";
import { getListWindowStart } from "./list-window.js";

const DIALOG_ACTION_ROWS = 8;
const DIALOG_BODY_ROWS = 5;
const SESSION_ROWS = 7;

export function ChoiceDialog(props: {
  choice: Extract<TuiViewState["transcript"][number], { kind: "choice" }>;
  selectedIndex: number;
}) {
  const theme = useTheme();
  const windowStart = () => getListWindowStart(props.choice.actions.length, props.selectedIndex, DIALOG_ACTION_ROWS);
  const visibleActions = () => props.choice.actions.slice(windowStart(), windowStart() + DIALOG_ACTION_ROWS);
  const visibleBody = () => clampBody(props.choice.body);

  return (
    <box
      width="100%"
      maxHeight={DIALOG_BODY_ROWS + DIALOG_ACTION_ROWS + 5}
      border
      borderStyle="rounded"
      borderColor={props.choice.tone === "warning" ? theme.warning : theme.focus}
      backgroundColor={theme.overlay}
      flexDirection="column"
      title={props.choice.title}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={visibleBody()}>
        {(body) => (
          <text width="100%" wrapMode="word" fg={theme.text}>
            {body()}
          </text>
        )}
      </Show>
      <For each={visibleActions()}>
        {(action, index) => {
          const absoluteIndex = () => windowStart() + index();
          const selected = () => absoluteIndex() === props.selectedIndex;
          return (
            <text width="100%" wrapMode="none" fg={selected() ? theme.accent : theme.text}>
              {selected() ? ">" : " "} {absoluteIndex() + 1}) {action.label}
            </text>
          );
        }}
      </For>
      <Show when={props.choice.actions.length > DIALOG_ACTION_ROWS}>
        <text fg={theme.muted}>
          {Math.min(props.choice.actions.length, windowStart() + DIALOG_ACTION_ROWS)}/{props.choice.actions.length}
        </text>
      </Show>
      <text fg={theme.muted}>↑↓ move · Enter accept · Esc cancel</text>
    </box>
  );
}

export function SessionPicker(props: { picker: NonNullable<TuiViewState["sessionPicker"]>; selectedIndex: number }) {
  const theme = useTheme();
  const windowStart = () => getListWindowStart(props.picker.items.length, props.selectedIndex, SESSION_ROWS);
  const visibleItems = () => props.picker.items.slice(windowStart(), windowStart() + SESSION_ROWS);

  return (
    <box
      width="100%"
      maxHeight={SESSION_ROWS + 4}
      border
      borderStyle="rounded"
      borderColor={theme.focus}
      backgroundColor={theme.overlay}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      title="Restore previous session"
    >
      <Show when={props.picker.items.length === 0}>
        <text fg={theme.muted}>No other sessions found.</text>
      </Show>
      <For each={visibleItems()}>
        {(item, index) => {
          const absoluteIndex = () => windowStart() + index();
          const selected = () => absoluteIndex() === props.selectedIndex;
          return (
            <text width="100%" wrapMode="none" fg={selected() ? theme.accent : theme.text}>
              {selected() ? ">" : " "} {item.updatedAt.slice(0, 16).replace("T", " ")} {item.sessionId.slice(0, 8)}{" "}
              {item.firstUserPrompt ?? "(no user prompt)"}
            </text>
          );
        }}
      </For>
      <Show when={props.picker.items.length > SESSION_ROWS}>
        <text fg={theme.muted}>
          {Math.min(props.picker.items.length, windowStart() + SESSION_ROWS)}/{props.picker.items.length}
        </text>
      </Show>
      <text fg={theme.muted}>↑↓ move · PgUp/PgDn · Enter restore · Esc cancel</text>
    </box>
  );
}

function clampBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }
  const lines = body.split("\n");
  if (lines.length <= DIALOG_BODY_ROWS) {
    return body;
  }
  return [...lines.slice(0, DIALOG_BODY_ROWS - 1), "…"].join("\n");
}
