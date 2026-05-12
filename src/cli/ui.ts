import { stderr, stdout } from "node:process";

const colors = {
  bgSoftGray: "\u001b[48;5;236m",
  blue: "\u001b[34m",
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
  model(text: string): string {
    return color(text, "blue");
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
  softBackground(text: string): string {
    return color(text, "bgSoftGray");
  },
  async spinner<T>(text: string, action: () => T | Promise<T>): Promise<T> {
    return withStatusLine(text, action, undefined, 80, false);
  },
  async progress<T>(text: string, action: (report: (message: string) => void) => T | Promise<T>): Promise<T> {
    let latest = text;

    return withStatusLine(
      text,
      () =>
        action((message) => {
          latest = message;
        }),
      () => latest,
      80,
      true
    );
  },
};

async function withStatusLine<T>(
  text: string,
  action: () => T | Promise<T>,
  getText: () => string = () => text,
  progressEveryMs = 80,
  emitPlainProgress = false
): Promise<T> {
  if (!shouldUseColor()) {
    if (!emitPlainProgress) {
      return action();
    }

    const timer = setInterval(
      () => {
        stderr.write(`${getText()}\n`);
      },
      Math.max(progressEveryMs, 5000)
    );

    try {
      return await action();
    } finally {
      clearInterval(timer);
    }
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;

  stderr.write(`${color(frames[index], "cyan")} ${getText()}`);
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    stderr.write(`\r\u001b[2K${color(frames[index], "cyan")} ${getText()}`);
  }, progressEveryMs);

  try {
    return await action();
  } finally {
    clearInterval(timer);
    stderr.write(`\r\u001b[2K`);
  }
}

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
