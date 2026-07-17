/** @jsxImportSource @opentui/solid */

import { Index, Show } from "solid-js";
import { type TaskPlanState } from "../../chat/controller-state.js";
import { useTheme } from "./context.js";

const MAX_TASK_ROWS = 5;
const TASK_PLAN_MARKERS = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
} as const;

export function TaskPlan(props: { plan: TaskPlanState }) {
  const theme = useTheme();
  return (
    <box
      width="100%"
      flexDirection="column"
      border={["left"]}
      borderColor={theme.warning}
      paddingLeft={1}
      backgroundColor={theme.background}
    >
      <Index each={props.plan.items.slice(0, MAX_TASK_ROWS)}>
        {(item) => (
          <text
            width="100%"
            wrapMode="word"
            fg={item().status === "in_progress" ? theme.warning : theme.muted}
            bg={theme.background}
            content={`${TASK_PLAN_MARKERS[item().status]} ${item().text}`}
          />
        )}
      </Index>
      <Show when={props.plan.items.length > MAX_TASK_ROWS}>
        <text fg={theme.muted} bg={theme.background} content={`… ${props.plan.items.length - MAX_TASK_ROWS} more`} />
      </Show>
    </box>
  );
}
