export interface RuntimeSteeringBuffer {
  drain(): string | undefined;
  hasPending(): boolean;
}

export class MutableRuntimeSteeringBuffer implements RuntimeSteeringBuffer {
  private readonly prompts: string[] = [];

  push(prompt: string): void {
    const trimmed = prompt.trim();
    if (trimmed.length > 0) {
      this.prompts.push(trimmed);
    }
  }

  drain(): string | undefined {
    if (this.prompts.length === 0) {
      return undefined;
    }

    return this.prompts.splice(0).join("\n\n");
  }

  hasPending(): boolean {
    return this.prompts.length > 0;
  }
}

export function formatRuntimeSteeringPrompt(steering: string): string {
  return [
    "User steering received while this turn was running:",
    steering.trim(),
    "",
    "Continue the user's original request, applying this steering if it is still relevant.",
  ].join("\n");
}
