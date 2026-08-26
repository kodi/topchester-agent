/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { type TuiViewState } from "../../chat/controller-state.js";
import { useController, useTheme } from "./context.js";
import { type TopchesterTheme } from "./theme.js";
import { formatContextStatusBar } from "../../chat/context-status.js";

export function StatusBar() {
  const { snapshot } = useController();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const model = createMemo(() => splitModelLabel(snapshot().modelLabel));
  const kb = createMemo(() => formatKnowledgeStatus(snapshot().knowledgeStatus, theme));
  const queue = createMemo(() => {
    const count = snapshot().queuedFollowUpCount;
    return count > 0 ? `queued: ${count}` : undefined;
  });
  const context = createMemo(() => {
    const status = snapshot().contextStatus;
    return status ? formatContextStatusBar(status, dimensions().width) : undefined;
  });
  const contextTone = createMemo(() => {
    const status = snapshot().contextStatus;
    if (!status?.budget.hardPromptBudget) return theme.muted;
    if (status.budget.usedTokens >= status.budget.hardPromptBudget) return theme.error;
    if (status.budget.usedTokens >= (status.budget.compactAtTokens ?? status.budget.hardPromptBudget)) {
      return theme.warning;
    }
    return theme.muted;
  });

  return (
    <box width="100%" flexDirection="column">
      <box width="100%" flexDirection="row">
        <Show
          when={snapshot().noticeLine}
          keyed
          fallback={
            <text flexGrow={1} flexShrink={1} wrapMode="none" fg={theme.text}>
              <span style={{ fg: snapshot().status === "ready" ? theme.success : theme.warning }}>
                ● {snapshot().status}
              </span>
              <span> · </span>
              <span style={{ fg: theme.muted }}></span>
              <span> {snapshot().workspaceLabel} · </span>
              <span style={{ fg: theme.accent }}>{model().model}</span>
              <Show when={model().provider}>
                <span style={{ fg: theme.muted }}>{model().provider}</span>
              </Show>
              <Show when={model().effort}>
                <span style={{ fg: theme.muted }}>{model().effort}</span>
              </Show>
            </text>
          }
        >
          {(notice) => (
            <text flexGrow={1} flexShrink={1} wrapMode="none" fg={theme.text}>
              <span style={{ fg: snapshot().status === "ready" ? theme.success : theme.warning }}>
                ● {snapshot().status}
              </span>
              <span> · {notice}</span>
            </text>
          )}
        </Show>
        <Show when={kb()}>
          {(status) => (
            <text flexShrink={0} marginLeft={1} wrapMode="none" fg={theme.text}>
              <span style={{ fg: status().tone }}>{status().icon}</span>
              <span> kb: </span>
              <span style={{ fg: status().tone }}>{status().label}</span>
              <Show when={status().syncLabel}>
                <span> | </span>
                <span style={{ fg: status().syncTone }}>{status().syncLabel}</span>
              </Show>
            </text>
          )}
        </Show>
      </box>
      <box width="100%" flexDirection="row">
        <text flexGrow={1} flexShrink={1} wrapMode="none" fg={theme.muted}>
          <Show when={queue()} keyed>
            {(label) => <span style={{ fg: theme.warning }}>{label}</span>}
          </Show>
          <Show when={queue() && dimensions().width >= 64}> · </Show>
          <Show when={dimensions().width >= 64}>session {snapshot().sessionId.slice(0, 8)}</Show>
        </text>
        <Show when={context()}>
          {(label) => (
            <text flexShrink={0} marginLeft={1} wrapMode="none" fg={contextTone()}>
              {label()}
            </text>
          )}
        </Show>
      </box>
    </box>
  );
}

function splitModelLabel(label: string): { model: string; provider?: string; effort?: string } {
  const match = /^(?<model>.*?)(?<provider> \[[^\]]+\])(?<effort> · effort .+)?$/u.exec(label);

  if (!match?.groups) {
    return { model: label };
  }

  return {
    model: match.groups.model ?? label,
    ...(match.groups.provider ? { provider: match.groups.provider } : {}),
    ...(match.groups.effort ? { effort: match.groups.effort } : {}),
  };
}

function formatKnowledgeStatus(
  status: TuiViewState["knowledgeStatus"],
  theme: TopchesterTheme
): { icon: string; label: string; tone: string; syncLabel?: string; syncTone?: string } | undefined {
  if (!status) {
    return undefined;
  }
  if (!status.kbExists) {
    return { icon: "⚠", label: "missing", tone: theme.warning };
  }
  if (!status.kbIsDirectory) {
    return { icon: "✕", label: "path conflict", tone: theme.error };
  }
  if (status.liveSync?.enabled) {
    const active = status.liveSync.queued + (status.liveSync.syncing ? 1 : 0);
    return {
      icon: "●",
      label: "live",
      tone: theme.success,
      syncLabel: active > 0 ? `${active} syncing` : `${status.currentEntryCount ?? 0} synced`,
      syncTone: active > 0 ? theme.warning : theme.success,
    };
  }
  if (status.kbContentState !== "ready") {
    return { icon: "○", label: "empty", tone: theme.muted };
  }
  if (status.nonCleanFileCount !== undefined) {
    const clean = status.nonCleanFileCount === 0;
    return {
      icon: "✅",
      label: "ready",
      tone: theme.success,
      syncLabel: clean ? "clean" : `${status.nonCleanFileCount} dirty`,
      syncTone: clean ? theme.success : theme.warning,
    };
  }
  return { icon: "✅", label: "ready", tone: theme.success };
}
