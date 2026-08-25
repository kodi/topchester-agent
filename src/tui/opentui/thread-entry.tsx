/** @jsxImportSource @opentui/solid */

import {
  BoxRenderable,
  CodeRenderable,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  type MarkdownOptions,
  type SyntaxStyle,
  type TextChunk,
} from "@opentui/core";
import hljs from "highlight.js";
import { Parser } from "htmlparser2";
import { formatStartupKnowledgeStatus, formatStartupTranscriptText, type TranscriptEntry } from "../../chat/index.js";
import { type TopchesterTheme } from "./theme.js";

export interface ThreadEntryProps {
  entry: TranscriptEntry;
  theme: TopchesterTheme;
  syntaxStyle: SyntaxStyle;
}

const KB_STATUS_ROW_PATTERN =
  /^(?<status>current|changed|missing_entry|missing_file|invalid)(?<padding>\s{2,})(?<size>\d+ bytes)(?<separator>\s{2,})(?<path>.+)$/u;

function knowledgeStatusTone(status: string, theme: TopchesterTheme): string {
  if (status === "current") return theme.success;
  if (status === "invalid" || status === "missing_file") return theme.error;
  return theme.warning;
}

function knowledgeStatusIcon(status: string): string {
  if (status === "current") return "✓";
  if (status === "invalid" || status === "missing_file") return "✕";
  if (status === "missing_entry") return "○";
  return "●";
}

function knowledgeMetadataIcon(label: string): string {
  if (label === "workspace") return "⌂";
  if (label === "knowledge folder") return "▣";
  if (label === "gitignore files read") return "≡";
  if (label === "config ignore rules") return "⚙";
  if (label.includes("files")) return "●";
  if (label === "state") return "✓";
  return "·";
}

function KnowledgeStatusResult(props: { text: string; theme: TopchesterTheme }) {
  return (
    <box width="100%" flexDirection="column">
      {props.text.split("\n").map((line) => {
        if (line === "KB status") {
          return <text fg={props.theme.accent}>◆ KB status</text>;
        }

        if (/^status\s+size\s+path$/u.test(line)) {
          return (
            <text width="100%" wrapMode="word" fg={props.theme.emphasis}>
              {"  "}
              {line}
            </text>
          );
        }

        const row = KB_STATUS_ROW_PATTERN.exec(line);
        if (row?.groups) {
          const { status, padding, size, separator, path } = row.groups;
          const tone = knowledgeStatusTone(status!, props.theme);
          return (
            <text width="100%" wrapMode="word" fg={props.theme.text}>
              <span style={{ fg: tone }}>
                {knowledgeStatusIcon(status!)} {status}
              </span>
              <span>{padding}</span>
              <span style={{ fg: props.theme.muted }}>{size}</span>
              <span>{separator}</span>
              <span style={{ fg: props.theme.info }}>▸</span>
              <span> {path}</span>
            </text>
          );
        }

        if (line === "----") {
          return <text fg={props.theme.muted}>┄┄┄┄</text>;
        }

        const separator = line.indexOf(":");
        if (separator > 0) {
          const label = line.slice(0, separator);
          return (
            <text width="100%" wrapMode="word" fg={props.theme.muted}>
              <span style={{ fg: props.theme.info }}>
                {knowledgeMetadataIcon(label)} {label}
              </span>
              <span>: {line.slice(separator + 1).trimStart()}</span>
            </text>
          );
        }

        return (
          <text width="100%" wrapMode="word" fg={props.theme.text}>
            {line}
          </text>
        );
      })}
    </box>
  );
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

    const renderContext = code.ctx;
    const language = token.lang?.trim().split(/\s+/u)[0]?.toLowerCase();
    const highlighted = language && hljs.getLanguage(language) ? highlightCode(token.text, language, theme) : undefined;
    const renderedCode = highlighted
      ? new TextRenderable(renderContext, {
          width: "100%",
          content: highlighted,
          fg: theme.text,
          bg: theme.surface,
          selectable: true,
          wrapMode: "none",
        })
      : code;
    if (renderedCode !== code) {
      code.destroyRecursively();
    } else {
      code.bg = theme.surface;
    }
    const container = new BoxRenderable(renderContext, {
      width: "100%",
      flexShrink: 0,
      backgroundColor: theme.surface,
    });
    container.add(renderedCode);
    return container;
  };
}

function highlightCode(code: string, language: string, theme: TopchesterTheme): StyledText | undefined {
  const chunks: TextChunk[] = [];
  const scopes: string[][] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        scopes.push(name === "span" ? (attributes.class ?? "").split(/\s+/u).filter(Boolean) : []);
      },
      ontext(text) {
        const style = resolveHighlightStyle(scopes.flat(), theme);
        chunks.push({ __isChunk: true, text, ...style });
      },
      onclosetag() {
        scopes.pop();
      },
    },
    { decodeEntities: true }
  );
  try {
    parser.end(hljs.highlight(code, { language, ignoreIllegals: true }).value);
    return new StyledText(chunks);
  } catch {
    return undefined;
  }
}

function resolveHighlightStyle(
  scopes: readonly string[],
  theme: TopchesterTheme
): Pick<TextChunk, "fg" | "attributes"> {
  const scope =
    [...scopes]
      .reverse()
      .find((value) => value.startsWith("hljs-"))
      ?.slice(5) ?? "";
  const color = (value: string) => RGBA.fromHex(value);

  if (["comment", "quote"].includes(scope)) {
    return { fg: color(theme.muted), attributes: TextAttributes.ITALIC };
  }
  if (["keyword", "selector-tag", "doctag", "meta-keyword"].includes(scope)) {
    return { fg: color(theme.accent), attributes: TextAttributes.BOLD };
  }
  if (["string", "regexp", "addition", "meta-string"].includes(scope)) {
    return { fg: color(theme.success) };
  }
  if (["number", "literal", "symbol", "bullet"].includes(scope)) {
    return { fg: color(theme.warning) };
  }
  if (["title", "section", "function", "name", "selector-id", "selector-class"].includes(scope)) {
    return { fg: color(theme.info) };
  }
  if (["type", "class", "built_in", "attr", "attribute", "property"].includes(scope)) {
    return { fg: color(theme.warning) };
  }
  if (["deletion", "error"].includes(scope)) {
    return { fg: color(theme.error) };
  }
  return { fg: color(theme.text) };
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
      if (entry.text === "KB status" || entry.text.startsWith("KB status\n")) {
        return <KnowledgeStatusResult text={entry.text} theme={props.theme} />;
      }
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
