/** @jsxImportSource @opentui/solid */

import { BoxRenderable, CodeRenderable, type MarkdownOptions, type SyntaxStyle } from "@opentui/core";
import { formatStartupKnowledgeStatus, formatStartupTranscriptText, type TranscriptEntry } from "../../chat/index.js";
import { type TopchesterTheme } from "./theme.js";

export interface ThreadEntryProps {
  entry: TranscriptEntry;
  theme: TopchesterTheme;
  syntaxStyle: SyntaxStyle;
}

function createFencedCodeRenderer(theme: TopchesterTheme): MarkdownOptions["renderNode"] {
  return (token, context) => {
    if (token.type !== "code") {
      return;
    }

    const code = context.defaultRender();
    if (!(code instanceof CodeRenderable)) {
      return code;
    }

    code.bg = theme.surface;
    const container = new BoxRenderable(code.ctx, {
      width: "100%",
      flexShrink: 0,
      backgroundColor: theme.surface,
    });
    container.add(code);
    return container;
  };
}

export function ThreadEntry(props: ThreadEntryProps) {
  const entry = props.entry;

  switch (entry.kind) {
    case "startup":
      return (
        <text width="100%" wrapMode="word" fg={props.theme.muted}>
          {formatStartupTranscriptText(entry)}
        </text>
      );
    case "system":
      return (
        <box width="100%" flexDirection="column">
          <text fg={props.theme.success}>✦ System:</text>
          <text width="100%" wrapMode="word" fg={props.theme.text}>
            {entry.text}
          </text>
        </box>
      );
    case "user":
      return (
        <box width="100%" border={["left"]} borderColor={props.theme.accent} paddingLeft={1}>
          <text width="100%" wrapMode="word" fg={props.theme.text}>
            {entry.text}
          </text>
        </box>
      );
    case "assistant":
      return (
        <box width="100%" flexDirection="column">
          <markdown
            width="100%"
            minHeight={1}
            content={entry.text}
            syntaxStyle={props.syntaxStyle}
            // OpenTUI 0.4.4 only draws unhighlighted Markdown immediately in streaming mode.
            // Stable scrollback snapshots cannot wait for the asynchronous parser before commit.
            streaming
            fg={props.theme.text}
            tableOptions={{ widthMode: "content" }}
            renderNode={createFencedCodeRenderer(props.theme)}
          />
          {entry.meta ? <text fg={props.theme.muted}>↳ {entry.meta}</text> : null}
        </box>
      );
    case "reasoning":
      return (
        <text width="100%" wrapMode="word" fg={props.theme.muted}>
          {entry.text}
        </text>
      );
    case "tool_call":
      return (
        <box width="100%" flexDirection="column">
          <text width="100%" wrapMode="word" fg={props.theme.muted}>
            {entry.label}
            {entry.resultSummary && !entry.label.includes(entry.resultSummary) ? ` ${entry.resultSummary}` : ""}
          </text>
          {entry.diff ? (
            <diff
              width="100%"
              diff={entry.diff}
              view="unified"
              wrapMode="word"
              syntaxStyle={props.syntaxStyle}
              fg={props.theme.text}
              addedBg={props.theme.diffAdded}
              removedBg={props.theme.diffRemoved}
              addedSignColor={props.theme.success}
              removedSignColor={props.theme.error}
            />
          ) : null}
        </box>
      );
    case "hook_status":
      return (
        <text width="100%" wrapMode="word" fg={props.theme.muted}>
          {entry.label}
        </text>
      );
    case "permission_auto_approved":
      return (
        <text width="100%" wrapMode="word" fg={props.theme.muted}>
          {entry.label}
        </text>
      );
    case "subagent":
      return (
        <text width="100%" wrapMode="word" fg={entry.status === "failed" ? props.theme.error : props.theme.muted}>
          ↳ task: {entry.title ?? entry.sessionId.slice(0, 8)} ({entry.status}){entry.text ? `\n  ${entry.text}` : ""}
        </text>
      );
    case "knowledge_status":
      return (
        <text width="100%" wrapMode="word" fg={props.theme.muted}>
          {formatStartupKnowledgeStatus(entry.status)}
        </text>
      );
    case "choice":
      return null;
  }
}
