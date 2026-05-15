const DEFAULT_MAX_PROMPTS = 100;

export class PromptHistory {
  private readonly maxPrompts: number;
  private prompts: string[] = [];
  private historyIndex = -1;
  private draft = "";

  constructor(maxPrompts = DEFAULT_MAX_PROMPTS) {
    this.maxPrompts = Math.max(1, maxPrompts);
  }

  add(value: string): void {
    const prompt = value.trim();
    this.resetBrowsing();

    if (prompt.length === 0 || prompt === this.prompts[0]) {
      return;
    }

    this.prompts.unshift(prompt);
    this.prompts = this.prompts.slice(0, this.maxPrompts);
  }

  previous(currentDraft: string): string | undefined {
    if (this.prompts.length === 0) {
      return undefined;
    }

    if (this.historyIndex === -1) {
      this.draft = currentDraft;
      this.historyIndex = 0;
      return this.prompts[this.historyIndex];
    }

    this.historyIndex = Math.min(this.historyIndex + 1, this.prompts.length - 1);
    return this.prompts[this.historyIndex];
  }

  next(): string | undefined {
    if (this.historyIndex === -1) {
      return undefined;
    }

    if (this.historyIndex === 0) {
      this.historyIndex = -1;
      return this.draft;
    }

    this.historyIndex -= 1;
    return this.prompts[this.historyIndex];
  }

  resetBrowsing(): void {
    this.historyIndex = -1;
    this.draft = "";
  }

  clear(): void {
    this.prompts = [];
    this.resetBrowsing();
  }
}
