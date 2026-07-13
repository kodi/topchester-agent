import { stdout } from "node:process";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { highlight, supportsLanguage } from "cli-highlight";
import { ui } from "../cli/ui.js";

const codeFenceSentinel = "\uE000topchester-code-fence\uE000";

export function renderMarkdown(text: string, width: number): string[] {
  const lines = new Markdown(unwrapMarkdownCodeFences(text), 0, 0, getMarkdownTheme()).render(width);
  const rendered: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.includes(codeFenceSentinel)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    rendered.push(inCodeBlock ? applyCodeBlockBackground(line) : line);
  }

  return rendered;
}

function unwrapMarkdownCodeFences(text: string): string {
  return text.replace(/^```(?:markdown|md)\s*\n([\s\S]*?)\n```$/gim, "$1");
}

function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => ui.label(text),
    link: (text) => ui.label(text),
    linkUrl: (text) => ui.muted(text),
    code: (text) => ui.ok(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => `${codeFenceSentinel}${ui.muted(text)}`,
    quote: (text) => ui.warn(text),
    quoteBorder: (text) => ui.warn(text),
    hr: (text) => ui.muted(text),
    listBullet: (text) => ui.label(text),
    bold: (text) => decorate(text, "\u001b[1m", "\u001b[22m"),
    italic: (text) => decorate(text, "\u001b[3m", "\u001b[23m"),
    strikethrough: (text) => decorate(text, "\u001b[9m", "\u001b[29m"),
    underline: (text) => decorate(text, "\u001b[4m", "\u001b[24m"),
    codeBlockIndent: "  ",
    highlightCode(code, lang) {
      const validLanguage = lang && supportsLanguage(lang) ? lang : undefined;

      if (!validLanguage) {
        return code.split("\n");
      }

      try {
        return highlight(code, { language: validLanguage, ignoreIllegals: true }).split("\n");
      } catch {
        return code.split("\n");
      }
    },
  };
}

function decorate(text: string, open: string, close: string): string {
  if (!shouldUseAnsi()) {
    return text;
  }

  return `${open}${text}${close}`;
}

function applyCodeBlockBackground(line: string): string {
  if (!shouldUseAnsi()) {
    return line;
  }

  const background = "\u001b[48;5;235m";
  const reset = "\u001b[0m";
  const lineWithPersistentBackground = line.split(reset).join(`${reset}${background}`);

  return `${background}${lineWithPersistentBackground}${reset}`;
}

function shouldUseAnsi(): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return stdout.isTTY === true;
}
