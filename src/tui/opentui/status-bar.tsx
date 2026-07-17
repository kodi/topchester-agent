/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { useController, useTheme } from "./context.js";

export function StatusBar() {
  const { snapshot } = useController();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const kb = createMemo(() => {
    const status = snapshot().knowledgeStatus;
    if (!status) return "";
    if (!status.kbExists) return " · kb: missing";
    if (!status.kbIsDirectory) return " · kb: conflict";
    return ` · kb: ${status.kbContentState === "ready" ? "ready" : "empty"}`;
  });
  const queue = createMemo(() => {
    const count = snapshot().queuedFollowUpCount;
    return count > 0 ? ` · queued: ${count}` : "";
  });

  return (
    <text width="100%" wrapMode="none" fg={theme.muted}>
      <span style={{ fg: snapshot().status === "ready" ? theme.success : theme.warning }}>● {snapshot().status}</span>
      <span> · {snapshot().modelLabel}</span>
      <Show when={dimensions().width >= 54}>{kb()}</Show>
      {queue()}
      <Show when={dimensions().width >= 90}> · {snapshot().workspaceLabel}</Show>
      <Show when={dimensions().width >= 112}> · session {snapshot().sessionId.slice(0, 8)}</Show>
      {snapshot().noticeLine ? ` · ${snapshot().noticeLine}` : ""}
    </text>
  );
}
