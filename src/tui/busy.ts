import { type ChatLayout } from "./layout.js";

export interface BusyIndicatorOptions {
  status: string;
  promptHint?: string;
  activityHint?: string;
  activities: string[];
  activityEveryMs?: number;
}

export interface BusyIndicatorStopOptions {
  clearEphemeralLine?: boolean;
}

interface RenderRequester {
  requestRender(): void;
}

export class BusyIndicator {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | undefined;
  private index = 0;
  private ticks = 0;
  private activityOverride: string | undefined;

  constructor(
    private readonly app: ChatLayout,
    private readonly tui: RenderRequester,
    private readonly options: BusyIndicatorOptions
  ) {}

  start(): void {
    this.app.setStatus(this.options.status);
    this.app.setPromptHint(this.options.promptHint);
    this.render();
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.ticks += 1;
      this.render();
      this.tui.requestRender();
    }, 80);
  }

  stop(options: BusyIndicatorStopOptions = {}): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.app.setPromptHint(undefined);

    if (options.clearEphemeralLine ?? true) {
      this.app.setEphemeralLine(undefined);
    }
  }

  setActivity(activity: string): void {
    this.activityOverride = activity;
    this.render();
    this.tui.requestRender();
  }

  clearActivity(): void {
    if (!this.activityOverride) {
      return;
    }

    this.activityOverride = undefined;
    this.render();
    this.tui.requestRender();
  }

  private render(): void {
    if (this.activityOverride) {
      this.app.setEphemeralLine(this.formatActivityLine(this.activityOverride));
      return;
    }

    const activityEveryMs = this.options.activityEveryMs ?? 1200;
    const activityIndex = Math.floor((this.ticks * 80) / activityEveryMs) % this.options.activities.length;
    this.app.setEphemeralLine(this.formatActivityLine(this.options.activities[activityIndex] ?? ""));
  }

  private formatActivityLine(activity: string): string {
    const hint = this.options.activityHint ? ` · ${this.options.activityHint}` : "";
    const lines = activity.split("\n");
    const activeLineIndex = lines.length - 1;

    return lines
      .map((line, index) => (index === activeLineIndex ? `${this.frames[this.index]} ${line}${hint}` : `  ${line}`))
      .join("\n");
  }
}

export class ReasoningTailBuffer {
  private text = "";

  get hasText(): boolean {
    return this.value.length > 0;
  }

  get value(): string {
    return formatReasoningText(this.text);
  }

  append(delta: string): string | undefined {
    this.text += delta;
    const formatted = this.value;

    if (!formatted) {
      return undefined;
    }

    return formatted;
  }

  replace(summary: string): string | undefined {
    this.text = summary;
    const formatted = this.value;

    if (!formatted) {
      return undefined;
    }

    return formatted;
  }

  clear(): void {
    this.text = "";
  }
}

const MAX_VISIBLE_REASONING_UPDATES = 6;
const boldHeadingBoundary = /\*\*\s*(?=\*\*)/gu;

function formatReasoningText(text: string): string {
  const hasHeadingSequence = /\*\*\s*(?=\*\*)/u.test(text);

  if (!hasHeadingSequence) {
    return stripWrappingBold(text.replace(/\s+/gu, " ").trim());
  }

  const updates = text
    .replace(boldHeadingBoundary, "**\n")
    .split(/\n+/u)
    .map((line) => stripWrappingBold(line.replace(/\s+/gu, " ").trim()))
    .filter(Boolean);

  if (updates.length <= MAX_VISIBLE_REASONING_UPDATES) {
    return updates.join("\n");
  }

  return ["… earlier thinking updates", ...updates.slice(-MAX_VISIBLE_REASONING_UPDATES)].join("\n");
}

function stripWrappingBold(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/^\*\*\s*/u, "")
    .replace(/\s*\*\*$/u, "")
    .trim();
}
