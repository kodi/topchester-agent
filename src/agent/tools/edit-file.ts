import { z } from "zod";

export const editFileEditSchema = z.object({
  old_text: z.string(),
  new_text: z.string(),
});

export const editFileArgsSchema = z.object({
  path: z.string(),
  expected_hash: z.string().optional(),
  edits: z.array(editFileEditSchema).min(1),
});

export type EditFileEdit = z.infer<typeof editFileEditSchema>;
export type EditFileToolArgs = z.infer<typeof editFileArgsSchema>;

export interface ApplyEditResult {
  newContent: string;
  diff: string;
  firstChangedLine: number;
}

interface MatchedEdit {
  edit: EditFileEdit;
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

type LineEnding = "lf" | "crlf";

export function applyExactEdits(content: string, edits: EditFileEdit[], path = "file"): ApplyEditResult {
  const document = splitDocument(content);
  const normalizedEdits = normalizeEdits(edits);
  const matches = findMatches(document.body, normalizedEdits);

  assertNoOverlaps(matches);

  let newBody = document.body;
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    newBody = `${newBody.slice(0, match.start)}${match.newText}${newBody.slice(match.end)}`;
  }

  if (newBody === document.body) {
    throw new Error("edit_file did not change the file content.");
  }

  return {
    newContent: joinDocument(newBody, document),
    diff: createUnifiedDiff(path, document.body, newBody),
    firstChangedLine: getFirstChangedLine(document.body, newBody),
  };
}

function normalizeEdits(edits: EditFileEdit[]): EditFileEdit[] {
  const seenOldText = new Set<string>();

  return edits.map((edit, index) => {
    const oldText = normalizeLineEndings(edit.old_text);
    const newText = normalizeLineEndings(edit.new_text);

    if (oldText.length === 0) {
      throw new Error(`edit_file old_text at index ${index} must not be empty.`);
    }

    if (seenOldText.has(oldText)) {
      throw new Error(`edit_file old_text at index ${index} duplicates an earlier edit.`);
    }

    seenOldText.add(oldText);
    return { old_text: oldText, new_text: newText };
  });
}

function findMatches(content: string, edits: EditFileEdit[]): MatchedEdit[] {
  return edits.map((edit, index) => {
    const starts = findAllOccurrences(content, edit.old_text);

    if (starts.length === 0) {
      throw new Error(`edit_file old_text at index ${index} was not found.`);
    }

    if (starts.length > 1) {
      throw new Error(`edit_file old_text at index ${index} matched ${starts.length} times; make it unique.`);
    }

    const start = starts[0]!;
    return {
      edit,
      oldText: edit.old_text,
      newText: edit.new_text,
      start,
      end: start + edit.old_text.length,
    };
  });
}

function findAllOccurrences(content: string, needle: string): number[] {
  const starts: number[] = [];
  let startIndex = 0;

  while (startIndex <= content.length) {
    const index = content.indexOf(needle, startIndex);
    if (index === -1) {
      return starts;
    }

    starts.push(index);
    startIndex = index + 1;
  }

  return starts;
}

function assertNoOverlaps(matches: MatchedEdit[]): void {
  const sortedMatches = [...matches].sort((left, right) => left.start - right.start);

  for (let index = 1; index < sortedMatches.length; index += 1) {
    const previous = sortedMatches[index - 1]!;
    const current = sortedMatches[index]!;

    if (previous.end > current.start) {
      throw new Error("edit_file edits must not overlap.");
    }
  }
}

function splitDocument(content: string): { bom: boolean; body: string; lineEnding: LineEnding } {
  const bom = content.startsWith("\uFEFF");
  const body = normalizeLineEndings(bom ? content.slice(1) : content);
  const lineEnding: LineEnding = content.includes("\r\n") ? "crlf" : "lf";

  return { bom, body, lineEnding };
}

function joinDocument(body: string, document: { bom: boolean; lineEnding: LineEnding }): string {
  const content = document.lineEnding === "crlf" ? body.replaceAll("\n", "\r\n") : body;
  return document.bom ? `\uFEFF${content}` : content;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getFirstChangedLine(oldContent: string, newContent: string): number {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const maxLength = Math.max(oldLines.length, newLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }

  return 1;
}

function createUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const prefixLength = countCommonPrefix(oldLines, newLines);
  const suffixLength = countCommonSuffix(oldLines, newLines, prefixLength);
  const oldChangedEnd = oldLines.length - suffixLength;
  const newChangedEnd = newLines.length - suffixLength;
  const contextLines = 3;
  const hunkOldStart = Math.max(0, prefixLength - contextLines);
  const hunkNewStart = Math.max(0, prefixLength - contextLines);
  const hunkOldEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const hunkNewEnd = Math.min(newLines.length, newChangedEnd + contextLines);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${formatHunkRange(hunkOldStart, hunkOldEnd)} +${formatHunkRange(hunkNewStart, hunkNewEnd)} @@`,
  ];

  for (let index = hunkOldStart; index < prefixLength; index += 1) {
    lines.push(` ${oldLines[index]}`);
  }

  for (let index = prefixLength; index < oldChangedEnd; index += 1) {
    lines.push(`-${oldLines[index]}`);
  }

  for (let index = prefixLength; index < newChangedEnd; index += 1) {
    lines.push(`+${newLines[index]}`);
  }

  for (let index = newChangedEnd; index < hunkNewEnd; index += 1) {
    lines.push(` ${newLines[index]}`);
  }

  return lines.join("\n");
}

function formatHunkRange(startIndex: number, endIndex: number): string {
  const lineCount = endIndex - startIndex;
  const startLine = lineCount === 0 ? startIndex : startIndex + 1;
  return `${startLine},${lineCount}`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function countCommonPrefix(left: string[], right: string[]): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function countCommonSuffix(left: string[], right: string[], prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  let count = 0;

  while (count < maxLength && left[left.length - count - 1] === right[right.length - count - 1]) {
    count += 1;
  }

  return count;
}
