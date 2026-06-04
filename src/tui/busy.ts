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

    return `${this.frames[this.index]} ${activity}${hint}`;
  }
}

export class ReasoningTailBuffer {
  private text = "";

  get hasText(): boolean {
    return this.text.length > 0;
  }

  get value(): string {
    return this.text;
  }

  append(delta: string): string | undefined {
    const normalized = normalizeReasoningText(`${this.text}${delta}`);

    if (!normalized) {
      return undefined;
    }

    this.text = normalized;

    return this.text;
  }

  replace(summary: string): string | undefined {
    const normalized = normalizeReasoningText(summary);

    if (!normalized) {
      return undefined;
    }

    this.text = normalized;

    return this.text;
  }

  clear(): void {
    this.text = "";
  }
}

function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
