/** @jsxImportSource @opentui/solid */

import { For, Show } from "solid-js";
import { type TaskPlanState } from "../../chat/controller-state.js";
import { useTheme } from "./context.js";

const MAX_TASK_ROWS = 5;

export function TaskPlan(props: { plan: TaskPlanState }) {
  const theme = useTheme();
  return (
    <box width="100%" flexDirection="column" border={["left"]} borderColor={theme.warning} paddingLeft={1}>
      <For each={props.plan.items.slice(0, MAX_TASK_ROWS)}>
        {(item) => (
          <text width="100%" wrapMode="word" fg={item.status === "in_progress" ? theme.warning : theme.muted}>
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"} {item.text}
          </text>
        )}
      </For>
      <Show when={props.plan.items.length > MAX_TASK_ROWS}>
        <text fg={theme.muted}>… {props.plan.items.length - MAX_TASK_ROWS} more</text>
      </Show>
    </box>
  );
}
