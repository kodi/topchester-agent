import { type ModelReasoningSink } from "../model/index.js";
import { reasoningTranscriptEntry } from "./transcript.js";
import { type TuiViewStore } from "./controller-state.js";

export interface ControllerBusyOptions {
  status: string;
  promptHint?: string;
  activityHint?: string;
  activities: string[];
  activityEveryMs?: number;
}

export class ControllerBusyIndicator {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: ReturnType<typeof setInterval> | undefined;
  private index = 0;
  private ticks = 0;
  private activityOverride: { text: string; tone: "normal" | "muted"; followTail: boolean } | undefined;

  constructor(
    private readonly view: TuiViewStore,
    private readonly options: ControllerBusyOptions
  ) {}

  start(): void {
    this.view.batch(() => {
      this.view.setStatus(this.options.status);
      this.view.setPromptHint(this.options.promptHint);
    });
    this.render();
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.ticks += 1;
      this.render();
    }, 80);
    this.timer.unref?.();
  }

  stop(options: { clearEphemeral?: boolean; clearPromptHint?: boolean } = {}): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.view.batch(() => {
      if (options.clearPromptHint ?? true) this.view.setPromptHint(undefined);
      if (options.clearEphemeral ?? true) this.view.setEphemeral(undefined);
    });
  }

  setActivity(text: string, tone: "normal" | "muted" = "normal", followTail = false): void {
    this.activityOverride = { text, tone, followTail };
    this.render();
  }

  clearActivity(): void {
    if (this.activityOverride) {
      this.activityOverride = undefined;
      this.render();
    }
  }

  private render(): void {
    const activityEveryMs = this.options.activityEveryMs ?? 1200;
    const activity =
      this.activityOverride ??
      ({
        text:
          this.options.activities[Math.floor((this.ticks * 80) / activityEveryMs) % this.options.activities.length] ??
          "",
        tone: "normal",
        followTail: false,
      } as const);
    const hint = this.options.activityHint ? ` · ${this.options.activityHint}` : "";
    if (activity.followTail) {
      this.view.setTransientEphemeral({
        text: activity.text,
        tone: activity.tone,
        tail: {
          indicator: this.frames[this.index] ?? "",
          ...(this.options.activityHint ? { hint: this.options.activityHint } : {}),
          maxRows: 3,
        },
      });
      return;
    }
    const lines = activity.text.split("\n");
    const activeLineIndex = lines.length - 1;
    const text = lines
      .map((line, index) => (index === activeLineIndex ? `${this.frames[this.index]} ${line}${hint}` : `  ${line}`))
      .join("\n");
    this.view.setTransientEphemeral({ text, tone: activity.tone });
  }
}

export function createControllerReasoningSink(
  view: TuiViewStore,
  busy: ControllerBusyIndicator
): { sink: ModelReasoningSink; commit(): void } {
  const buffer = new ReasoningTailBuffer();
  let committed = false;

  return {
    commit() {
      if (committed || !buffer.hasText) {
        return;
      }
      view.addEntry(reasoningTranscriptEntry(buffer.value));
      committed = true;
    },
    async sink(event) {
      if (event.type === "clear") {
        buffer.clear();
        committed = false;
        busy.clearActivity();
        return;
      }
      const text = event.type === "summary" ? buffer.replace(event.text ?? "") : buffer.append(event.text ?? "");
      if (text) {
        busy.setActivity(text, "muted", true);
      }
    },
  };
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
    return this.value || undefined;
  }

  replace(summary: string): string | undefined {
    this.text = summary;
    return this.value || undefined;
  }

  clear(): void {
    this.text = "";
  }
}

const MAX_VISIBLE_REASONING_UPDATES = 6;

function formatReasoningText(text: string): string {
  const hasHeadingSequence = /\*\*\s*(?=\*\*)/u.test(text);
  if (!hasHeadingSequence) {
    return stripWrappingBold(text.replace(/\s+/gu, " ").trim());
  }
  const updates = text
    .replace(/\*\*\s*(?=\*\*)/gu, "**\n")
    .split(/\n+/u)
    .map((line) => stripWrappingBold(line.replace(/\s+/gu, " ").trim()))
    .filter(Boolean);
  return updates.length <= MAX_VISIBLE_REASONING_UPDATES
    ? updates.join("\n")
    : ["… earlier thinking updates", ...updates.slice(-MAX_VISIBLE_REASONING_UPDATES)].join("\n");
}

function stripWrappingBold(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/^\*\*\s*/u, "")
    .replace(/\s*\*\*$/u, "")
    .trim();
}
