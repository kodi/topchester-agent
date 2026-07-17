/** @jsxImportSource @opentui/solid */

import { For, Show } from "solid-js";
import { useTheme } from "./context.js";
import { ACTIVE_ROW_MARKER, getListWindowStart } from "./list-window.js";

export interface SuggestionListProps {
  items: readonly string[];
  selectedIndex: number;
  visibleRows?: number;
}

export function SuggestionList(props: SuggestionListProps) {
  const theme = useTheme();
  const visibleRows = () => props.visibleRows ?? 6;
  const windowStart = () => getListWindowStart(props.items.length, props.selectedIndex, visibleRows());
  const visibleItems = () => props.items.slice(windowStart(), windowStart() + visibleRows());

  return (
    <box width="100%" maxHeight={visibleRows() + 1} flexDirection="column" backgroundColor={theme.overlay}>
      <For each={visibleItems()}>
        {(item, index) => {
          const absoluteIndex = () => windowStart() + index();
          const selected = () => absoluteIndex() === props.selectedIndex;
          return (
            <text
              width="100%"
              wrapMode="none"
              fg={selected() ? theme.accent : theme.muted}
              bg={theme.overlay}
              content={`${selected() ? ACTIVE_ROW_MARKER : " "} ${item}`}
            />
          );
        }}
      </For>
      <Show when={props.items.length > visibleRows()}>
        <text
          fg={theme.muted}
          bg={theme.overlay}
          content={`${Math.min(props.items.length, windowStart() + visibleRows())}/${props.items.length}`}
        />
      </Show>
    </box>
  );
}
