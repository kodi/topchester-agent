import { type ChatLayout } from "./layout.js";

export interface BusyIndicatorOptions {
  status: string;
  promptHint: string;
  activities: string[];
}

interface RenderRequester {
  requestRender(): void;
}

export class BusyIndicator {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | undefined;
  private index = 0;
  private ticks = 0;

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

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.app.setPromptHint(undefined);
    this.app.setEphemeralLine(undefined);
  }

  private render(): void {
    const activityIndex = Math.floor(this.ticks / 15) % this.options.activities.length;
    this.app.setEphemeralLine(`${this.frames[this.index]} ${this.options.activities[activityIndex]}`);
  }
}
