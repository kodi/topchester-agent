import { diffWords } from "diff";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ui } from "../cli/ui.js";

export interface RenderDiffOptions {
  indent?: string;
  width?: number;
}

interface DiffBodyLine {
  kind: "added" | "removed" | "context";
  content: string;
}

export function renderUnifiedDiff(diffText: string, options: RenderDiffOptions = {}): string[] {
  const indent = options.indent ?? "";
  const wrapWidth = options.width === undefined ? undefined : Math.max(1, options.width - indent.length);
  const rawLines = diffText.split("\n");
  const rendered: string[] = [];

  let index = 0;
  while (index < rawLines.length) {
    const line = rawLines[index]!;

    if (isRemovedBodyLine(line)) {
      const removed: DiffBodyLine[] = [];
      while (index < rawLines.length && isRemovedBodyLine(rawLines[index]!)) {
        removed.push({ kind: "removed", content: rawLines[index]!.slice(1) });
        index += 1;
      }

      const added: DiffBodyLine[] = [];
      while (index < rawLines.length && isAddedBodyLine(rawLines[index]!)) {
        added.push({ kind: "added", content: rawLines[index]!.slice(1) });
        index += 1;
      }

      rendered.push(...renderChangedLines(removed, added, indent, wrapWidth));
      continue;
    }

    if (isAddedBodyLine(line)) {
      rendered.push(...renderWrappedLine(ui.ok(`+${expandTabs(line.slice(1))}`), indent, wrapWidth));
    } else if (line.startsWith("@@")) {
      rendered.push(...renderWrappedLine(ui.model(line), indent, wrapWidth));
    } else if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      rendered.push(...renderWrappedLine(ui.muted(line), indent, wrapWidth));
    } else if (line.startsWith(" ")) {
      rendered.push(...renderWrappedLine(ui.label(` ${expandTabs(line.slice(1))}`), indent, wrapWidth));
    } else if (line.length > 0) {
      rendered.push(...renderWrappedLine(ui.label(line), indent, wrapWidth));
    }

    index += 1;
  }

  return rendered;
}

function renderChangedLines(
  removedLines: DiffBodyLine[],
  addedLines: DiffBodyLine[],
  indent: string,
  wrapWidth: number | undefined
): string[] {
  if (removedLines.length === 1 && addedLines.length === 1) {
    const { removed, added } = renderIntraLineDiff(
      expandTabs(removedLines[0]!.content),
      expandTabs(addedLines[0]!.content)
    );

    return [
      ...renderWrappedLine(ui.error(`-${removed}`), indent, wrapWidth),
      ...renderWrappedLine(ui.ok(`+${added}`), indent, wrapWidth),
    ];
  }

  return [
    ...removedLines.flatMap((line) => renderWrappedLine(ui.error(`-${expandTabs(line.content)}`), indent, wrapWidth)),
    ...addedLines.flatMap((line) => renderWrappedLine(ui.ok(`+${expandTabs(line.content)}`), indent, wrapWidth)),
  ];
}

function renderIntraLineDiff(oldContent: string, newContent: string): { removed: string; added: string } {
  const parts = diffWords(oldContent, newContent);
  let removed = "";
  let added = "";

  for (const part of parts) {
    if (part.removed) {
      removed += highlightChangedPart(part.value);
    } else if (part.added) {
      added += highlightChangedPart(part.value);
    } else {
      removed += part.value;
      added += part.value;
    }
  }

  return { removed, added };
}

function highlightChangedPart(value: string): string {
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const body = value.slice(leading.length, value.length - trailing.length);

  return body.length === 0 ? value : `${leading}${ui.inverse(body)}${trailing}`;
}

function renderWrappedLine(line: string, indent: string, width: number | undefined): string[] {
  const wrapped = width === undefined ? [line] : wrapTextWithAnsi(line, width);
  return wrapped.map((part) => `${indent}${part}`);
}

function isRemovedBodyLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("--- ");
}

function isAddedBodyLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++ ");
}

function expandTabs(text: string): string {
  return text.replace(/\t/gu, "    ");
}
