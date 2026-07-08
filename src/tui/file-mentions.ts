export interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

export interface MentionRange {
  start: number;
  end: number;
}

export function findActiveMention(value: string, cursor: number): ActiveMention | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const tokenStart = findTokenStart(value, safeCursor);

  if (tokenStart === undefined || value[tokenStart] !== "@") {
    return undefined;
  }

  if (tokenStart > 0 && !isWhitespace(value[tokenStart - 1] ?? "")) {
    return undefined;
  }

  const tokenEnd = findTokenEnd(value, safeCursor);

  return {
    start: tokenStart,
    end: tokenEnd,
    query: value.slice(tokenStart + 1, safeCursor),
  };
}

export function findMentionRanges(value: string): MentionRange[] {
  const ranges: MentionRange[] = [];
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "@" || (index > 0 && !isWhitespace(value[index - 1] ?? ""))) {
      index += 1;
      continue;
    }

    const end = findTokenEnd(value, index + 1);
    if (end > index + 1) {
      ranges.push({ start: index, end });
    }

    index = Math.max(index + 1, end);
  }

  return ranges;
}

export function applyMentionCompletion(
  value: string,
  mention: ActiveMention,
  path: string,
  isDirectory: boolean
): { value: string; cursor: number } {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const suffix = isDirectory ? "/" : " ";
  const replacement = `@${normalizedPath}${suffix}`;
  const remainderStart = !isDirectory && isWhitespace(value[mention.end] ?? "") ? mention.end + 1 : mention.end;
  const nextValue = `${value.slice(0, mention.start)}${replacement}${value.slice(remainderStart)}`;

  return {
    value: nextValue,
    cursor: mention.start + replacement.length,
  };
}

function findTokenStart(value: string, cursor: number): number | undefined {
  let index = Math.max(0, Math.min(cursor, value.length));

  while (index > 0 && !isWhitespace(value[index - 1] ?? "")) {
    index -= 1;
  }

  return index;
}

function findTokenEnd(value: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, value.length));

  while (index < value.length && !isWhitespace(value[index] ?? "")) {
    index += 1;
  }

  return index;
}

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}
