import { truncateToWidth } from "@earendil-works/pi-tui";

export function padLines(lines: string[], height: number, width: number): string[] {
  const padding = Array.from({ length: Math.max(0, height - lines.length) }, () => "");

  return [...padding, ...lines].map((line) => truncateToWidth(line, width, "…", true));
}

export function padThreadLine(line: string, width: number): string {
  return truncateToWidth(line, width, "…", true);
}

export function stripAnsi(text: string): string {
  let plain = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m") {
        index += 1;
      }
      continue;
    }

    plain += text[index];
  }

  return plain;
}
