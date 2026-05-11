import { matchesKey } from "@earendil-works/pi-tui";

export function isUpKey(data: string): boolean {
  return matchesKey(data, "up") || data === "\u001b[A";
}

export function isDownKey(data: string): boolean {
  return matchesKey(data, "down") || data === "\u001b[B";
}

export function isEnterKey(data: string): boolean {
  return matchesKey(data, "enter") || data === "\n" || data === "\r";
}

export function isTabKey(data: string): boolean {
  return matchesKey(data, "tab") || data === "\t";
}

export function isPageUpKey(data: string): boolean {
  return data === "\u001b[5~";
}

export function isPageDownKey(data: string): boolean {
  return data === "\u001b[6~";
}

export function isHomeKey(data: string): boolean {
  return matchesKey(data, "home") || data === "\u001b[H" || data === "\u001b[1~";
}

export function isEndKey(data: string): boolean {
  return matchesKey(data, "end") || data === "\u001b[F" || data === "\u001b[4~";
}

export function parseMouseWheel(data: string): "up" | "down" | undefined {
  const sgrMatch = data.match(new RegExp(`^${escapeRegex("\u001b")}${escapeRegex("[<")}(\\d+);\\d+;\\d+M$`));
  if (sgrMatch) {
    return getWheelDirection(Number(sgrMatch[1]));
  }

  if (data.startsWith("\u001b[M") && data.length >= 6) {
    return getWheelDirection(data.charCodeAt(3) - 32);
  }

  return undefined;
}

function getWheelDirection(button: number): "up" | "down" | undefined {
  if ((button & 64) !== 64) {
    return undefined;
  }

  return (button & 1) === 0 ? "up" : "down";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
