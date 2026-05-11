import { stderr, stdout } from "node:process";

const colors = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
};

export const ui = {
  heading(text: string): string {
    return color(`Topchester ${text}`, "cyan");
  },
  label(text: string): string {
    return color(text, "dim");
  },
  ok(text: string): string {
    return color(text, "green");
  },
  warn(text: string): string {
    return color(text, "yellow");
  },
  error(text: string): string {
    return color(text, "red");
  },
  async spinner<T>(text: string, action: () => T | Promise<T>): Promise<T> {
    if (!shouldUseColor()) {
      return action();
    }

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let index = 0;

    stderr.write(`${color(frames[index], "cyan")} ${text}`);
    const timer = setInterval(() => {
      index = (index + 1) % frames.length;
      stderr.write(`\r${color(frames[index], "cyan")} ${text}`);
    }, 80);

    try {
      return await action();
    } finally {
      clearInterval(timer);
      stderr.write(`\r\u001b[2K`);
    }
  },
};

export function color(text: string, colorName: keyof typeof colors): string {
  if (!shouldUseColor()) {
    return text;
  }

  return `${colors[colorName]}${text}${colors.reset}`;
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return stdout.isTTY === true;
}
