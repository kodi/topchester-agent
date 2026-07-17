import { PromptHistory } from "../../chat/prompt-history.js";

const PASTE_PREVIEW_MIN_LINES = 6;
const PASTE_PREVIEW_MIN_CHARS = 500;

export class ComposerState {
  private readonly history = new PromptHistory();
  private readonly pastedContent = new Map<string, string>();
  private pasteCounter = 0;

  preparePaste(text: string): string {
    const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\t/gu, "    ");
    const trimmed = normalized.trim();
    if (!trimmed) {
      return "";
    }

    const lineCount = trimmed.split("\n").length;
    if (lineCount < PASTE_PREVIEW_MIN_LINES && trimmed.length < PASTE_PREVIEW_MIN_CHARS) {
      return normalized;
    }

    this.pasteCounter += 1;
    const marker = `[Pasted #${this.pasteCounter} ${lineCount} lines ${trimmed.length} chars]`;
    this.pastedContent.set(marker, trimmed);
    return marker;
  }

  expandSubmission(value: string): string {
    let expanded = value;
    for (const [marker, content] of this.pastedContent) {
      expanded = expanded.split(marker).join(content);
    }
    this.pastedContent.clear();
    this.pasteCounter = 0;
    return expanded.trim();
  }

  recordSubmission(value: string): void {
    this.history.add(value);
  }

  previousHistory(currentDraft: string): string | undefined {
    return this.history.previous(currentDraft);
  }

  nextHistory(): string | undefined {
    return this.history.next();
  }

  resetHistoryBrowsing(): void {
    this.history.resetBrowsing();
  }

  resetSession(): void {
    this.history.clear();
    this.pastedContent.clear();
    this.pasteCounter = 0;
  }
}
