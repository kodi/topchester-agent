import { type MentionRange } from "./file-mentions.js";

export function renderMentionStyles(text: string, absoluteStart: number, ranges: MentionRange[]): string {
  if (text.length === 0 || ranges.length === 0) {
    return text;
  }

  let rendered = "";
  let segmentStart = 0;

  while (segmentStart < text.length) {
    const absoluteIndex = absoluteStart + segmentStart;
    const range = ranges.find((candidate) => absoluteIndex >= candidate.start && absoluteIndex < candidate.end);
    const segmentEndAbsolute = range
      ? Math.min(absoluteStart + text.length, range.end)
      : Math.min(
          absoluteStart + text.length,
          ranges.find((candidate) => candidate.start > absoluteIndex)?.start ?? absoluteStart + text.length
        );
    const segmentEnd = Math.max(segmentStart + 1, segmentEndAbsolute - absoluteStart);
    const segment = text.slice(segmentStart, segmentEnd);

    rendered += range ? styleMentionText(segment) : segment;
    segmentStart = segmentEnd;
  }

  return rendered;
}

export function styleMentionText(text: string): string {
  return `\u001b[1m\u001b[96m${text}\u001b[39m\u001b[22m`;
}

export function isIndexInMentionRange(index: number, ranges: MentionRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
