import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ChatLayout,
  BusyIndicator,
  colorAsciiBanner,
  getRandomAsciiBanner,
  getRandomAsciiBannerColor,
  enterAlternateScreen,
  exitAlternateScreen,
  formatKnowledgeFooterStatus,
  formatKnowledgePathStatus,
  formatStatusLine,
  getKnowledgeStatusMessages,
  getStartupThreadMessages,
} from "../src/tui/index.js";
import { getKnowledgeStatus } from "../src/knowledge/status.js";
import {
  TopchesterTuiShell,
  createExitConfirmationInputListener,
  formatDuration,
  persistMessagesWithWarning,
  printExitBanner,
  runtimeEventToSessionPayload,
  slashCommandToSessionPayload,
} from "../src/tui/shell.js";
import {
  agentMessage,
  type ChatMessage,
  modalMessage,
  renderChatMessage,
  systemMessage,
  userMessage,
} from "../src/tui/messages.js";
import { type Terminal } from "@earendil-works/pi-tui";
import { type AppContext } from "../src/app/context.js";
import { getTopchesterSessionsPath } from "../src/app/paths.js";
import { agentEvent } from "../src/agent/events.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime.js";
import { type SessionEventPayload } from "../src/session/events.js";
import { createSession, loadSession, rehydrateSession, type SessionHandle } from "../src/session/store.js";

// fake terminal for testing - 2
class FakeTerminal implements Terminal {
  columns = 60;
  rows = 10;
  kittyProtocolActive = false;
  writes: string[] = [];
  clearCount = 0;

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {
    this.clearCount += 1;
  }
  setTitle(): void {}
  setProgress(): void {}
}

describe("TUI rendering", () => {
  it("formats session durations for the exit banner", () => {
    expect(formatDuration(0)).toBe("0 seconds");
    expect(formatDuration(1000)).toBe("1 second");
    expect(formatDuration(61_000)).toBe("1 minute 1 second");
    expect(formatDuration(3_661_000)).toBe("1 hour 1 minute 1 second");
  });

  it("prints an exit banner with resume command", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      printExitBanner("80343a57-3013-4977-b547-591419ed84eb", 125_000);

      expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("Topchester session ended");
      expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("after 2 minutes 5 seconds");
      expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
        "topchester --resume 80343a57-3013-4977-b547-591419ed84eb"
      );
    } finally {
      log.mockRestore();
    }
  });

  it("selects an ASCII banner from the provided list", () => {
    expect(getRandomAsciiBanner(["one", "two", "three"], () => 0.6)).toBe("two");
  });

  it("returns no banner when the banner list is empty", () => {
    expect(getRandomAsciiBanner([], () => 0)).toBeUndefined();
  });

  it("selects an ASCII banner color from the provided list", () => {
    expect(getRandomAsciiBannerColor(["purple", "blue", "yellow"], () => 0.7)).toBe("yellow");
  });

  it("colors ASCII banners when color is enabled", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      expect(colorAsciiBanner("banner\nnext", () => 0)).toBe("\u001b[35mbanner\u001b[0m\n\u001b[35mnext\u001b[0m");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("adds two top and bottom padding lines around the startup banner", () => {
    const [message] = getStartupThreadMessages({
      workspaceRoot: "/repo",
      config: {},
      devFlags: new Set(),
      modelGateway: {} as AppContext["modelGateway"],
      logger: {} as AppContext["logger"],
    });

    expect(message?.kind).toBe("system");
    if (message?.kind !== "system") {
      throw new Error("Expected startup message to be a system message.");
    }

    const lines = message.text.split("\n");
    const workspaceIndex = lines.findIndex((line) => line.includes("workspace"));

    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("");
    expect(lines[workspaceIndex - 2]).toBe("");
    expect(lines[workspaceIndex - 1]).toBe("");
  });

  it("keeps status line output unchanged when no KB status is supplied", () => {
    expect(formatStatusLine("repo", "model [provider]")).toBe("● ready ·  repo · model [provider]");
  });

  it("appends optional KB status to the status line", () => {
    expect(formatStatusLine("repo", "model [provider]", "ready", "kb: ready")).toBe(
      "● ready ·  repo · model [provider] · kb: ready"
    );
  });

  it("right-aligns KB status when a footer width is supplied", () => {
    const line = formatStatusLine("repo", "model [provider]", "ready", "✅ kb: ready", 60);

    expect(visibleWidth(line)).toBe(60);
    expect(line.endsWith("✅ kb: ready")).toBe(true);
    expect(line).toContain("● ready ·  repo · model [provider]");
  });

  it("keeps right-aligned KB status visible when the status line is narrow", () => {
    const line = formatStatusLine(
      "topchester-agent",
      "google/gemini-2.5-flash-lite [openrouter]",
      "ready",
      "✅ kb: ready",
      34
    );

    expect(visibleWidth(line)).toBe(34);
    expect(line.endsWith("✅ kb: ready")).toBe(true);
  });

  it("colors the footer model blue and provider gray when color is enabled", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      expect(formatStatusLine("repo", "google/gemini-2.5-flash-lite [openrouter]")).toContain(
        "\u001b[34mgoogle/gemini-2.5-flash-lite\u001b[0m\u001b[2m [openrouter]\u001b[0m"
      );
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("formats compact KB footer status labels", () => {
    const baseStatus = {
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default" as const,
      cachePathSource: "default" as const,
    };

    expect(
      formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: true, kbContentState: "ready" })
    ).toBe("✅ kb: ready");
    expect(
      formatKnowledgeFooterStatus({
        ...baseStatus,
        kbExists: true,
        kbIsDirectory: true,
        kbContentState: "ready",
        nonCleanFileCount: 0,
      })
    ).toBe("✅ kb: ready | clean");
    expect(
      formatKnowledgeFooterStatus({
        ...baseStatus,
        kbExists: true,
        kbIsDirectory: true,
        kbContentState: "ready",
        nonCleanFileCount: 41,
      })
    ).toBe("✅ kb: ready | 41 dirty");
    expect(
      formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: true, kbContentState: "empty" })
    ).toBe("○ kb: empty");
    expect(formatKnowledgeFooterStatus({ ...baseStatus, kbExists: false, kbIsDirectory: false })).toBe("⚠ kb: missing");
    expect(formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: false })).toBe(
      "✕ kb: path conflict"
    );
  });

  it("detects empty and ready KB content from the manifest", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-kb-status-"));
    const kbPath = join(workspace, "topchester-kb");
    await mkdir(kbPath, { recursive: true });

    expect(getKnowledgeStatus(workspace).kbContentState).toBe("empty");

    await writeFile(
      join(kbPath, "manifest.json"),
      JSON.stringify({ l1: { completed: 0, currentEntries: 1 } }, null, 2)
    );

    expect(getKnowledgeStatus(workspace).kbContentState).toBe("ready");
  });

  it("colors compact KB footer status labels when color is enabled", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    const baseStatus = {
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default" as const,
      cachePathSource: "default" as const,
    };
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      expect(
        formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: true, kbContentState: "ready" })
      ).toBe("\u001b[32m✅\u001b[0m kb: \u001b[32mready\u001b[0m");
      expect(
        formatKnowledgeFooterStatus({
          ...baseStatus,
          kbExists: true,
          kbIsDirectory: true,
          kbContentState: "ready",
          nonCleanFileCount: 2,
        })
      ).toBe("\u001b[32m✅\u001b[0m kb: \u001b[32mready\u001b[0m | \u001b[33m2 dirty\u001b[0m");
      expect(
        formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: true, kbContentState: "empty" })
      ).toBe("\u001b[2m○\u001b[0m kb: \u001b[2mempty\u001b[0m");
      expect(formatKnowledgeFooterStatus({ ...baseStatus, kbExists: false, kbIsDirectory: false })).toBe(
        "\u001b[33m⚠\u001b[0m kb: \u001b[33mmissing\u001b[0m"
      );
      expect(formatKnowledgeFooterStatus({ ...baseStatus, kbExists: true, kbIsDirectory: false })).toBe(
        "\u001b[31m✕\u001b[0m kb: \u001b[31mpath conflict\u001b[0m"
      );
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("enters and exits the terminal alternate screen", () => {
    const terminal = new FakeTerminal();

    enterAlternateScreen(terminal);
    exitAlternateScreen(terminal);

    expect(terminal.writes).toEqual(["\u001b[?1049h", "\u001b[?1049l"]);
    expect(terminal.clearCount).toBe(1);
  });

  it("renders the prompt box and status line", () => {
    const app = new ChatLayout(new FakeTerminal(), [systemMessage("Welcome")], "repo", "model [provider]");

    const output = app.render(60).join("\n");

    expect(output).toContain(" ✦ System:");
    expect(output).toContain("   Welcome");
    expect(output).toContain("│ >");
    expect(output).toContain("● ready ·  repo · model [provider]");
  });

  it("colors tool call lines dark gray in system messages", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      expect(renderChatMessage(systemMessage("edit_file: test-foo.ts (changed +1/-1)"))).toContain(
        "   \u001b[90medit_file: test-foo.ts (changed +1/-1)\u001b[0m"
      );
      expect(renderChatMessage(systemMessage("inspect_command: pwd && rg --files docs/plans | head -20"))).toContain(
        "   \u001b[90minspect_command: pwd && rg --files docs/plans | head -20\u001b[0m"
      );
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("expands tabs in system messages before wrapping", () => {
    expect(renderChatMessage(systemMessage("changed\ttest/commands.test.ts\t17154 bytes"))).toContain(
      "   changed test/commands.test.ts   17154 bytes"
    );
  });

  it("renders user messages with a left border and no label", () => {
    expect(renderChatMessage(userMessage("hello"))).toEqual(["▌ ", "▌ hello", "▌ "]);
    expect(renderChatMessage(userMessage("hello")).join("\n")).not.toContain("You:");
  });

  it("colors user message rows with a blue left border and full soft background", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      const app = new ChatLayout(new FakeTerminal(), [userMessage("hello")], "repo", "model [provider]");
      const output = app.render(60).join("\n");

      expect(output).toContain("\u001b[48;5;236m\u001b[34m▌\u001b[39m hello");
      expect(output).not.toContain("\u001b[34m▌\u001b[0m hello");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("renders stored KB status in the footer", () => {
    const app = new ChatLayout(new FakeTerminal(), [systemMessage("Welcome")], "repo", "model [provider]");

    app.setKnowledgeStatus({
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: true,
      kbIsDirectory: true,
      kbContentState: "ready",
      nonCleanFileCount: 1,
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default",
      cachePathSource: "default",
    });
    const output = app.render(80).join("\n");

    expect(output).toContain("● ready ·  repo · model [provider]");
    expect(output).toContain("✅ kb: ready | 1 dirty");
  });

  it("pads the status footer by one column on each edge", () => {
    const app = new ChatLayout(new FakeTerminal(), [systemMessage("Welcome")], "repo", "model [provider]");

    app.setKnowledgeStatus({
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: true,
      kbIsDirectory: true,
      kbContentState: "ready",
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default",
      cachePathSource: "default",
    });
    const footer = app.render(80).at(-1) ?? "";

    expect(visibleWidth(footer)).toBe(80);
    expect(footer.startsWith(" ")).toBe(true);
    expect(footer.endsWith(" ")).toBe(true);
    expect(footer.trimEnd().endsWith("✅ kb: ready")).toBe(true);
  });

  it("renders busy state as an ephemeral chat line with a prompt hint", () => {
    const app = new ChatLayout(new FakeTerminal(), [systemMessage("Welcome")], "repo", "model [provider]");
    app.setEphemeralLine("⠋ Calling agent.fast...");
    app.setPromptHint("press Esc to stop");

    const output = app.render(60).join("\n");

    expect(output).toContain(" ⠋ Calling agent.fast...");
    expect(output).toContain("│ > press Esc to stop");
  });

  it("renders exit notice separately from busy ephemeral rows", () => {
    const app = new ChatLayout(new FakeTerminal(), [systemMessage("Welcome")], "repo", "model [provider]");
    app.setEphemeralLine("⠋ Calling agent.fast...");
    app.setNoticeLine("press Ctrl-C again to exit.");

    const output = app.render(60).join("\n");

    expect(output).toContain(" ⠋ Calling agent.fast...");
    expect(output).toContain(" press Ctrl-C again to exit.");
  });

  it("exits on the second Ctrl-C without clearing on terminal responses", () => {
    vi.useFakeTimers();
    let notice: string | undefined;
    let renderCount = 0;
    let exitCount = 0;
    const listener = createExitConfirmationInputListener({
      timeoutMs: 2500,
      setNoticeLine: (line) => {
        notice = line;
      },
      requestRender: () => {
        renderCount += 1;
      },
      exit: () => {
        exitCount += 1;
      },
    });

    try {
      expect(listener("\u0003")).toEqual({ consume: true });
      expect(notice).toBe("press Ctrl-C again to exit.");
      expect(exitCount).toBe(0);

      expect(listener("\u001b[6;20;10t")).toBeUndefined();
      expect(notice).toBe("press Ctrl-C again to exit.");

      expect(listener("\u0003")).toEqual({ consume: true });
      expect(exitCount).toBe(1);
      expect(renderCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not exit from a Kitty Ctrl-C key release", () => {
    vi.useFakeTimers();
    let notice: string | undefined;
    let exitCount = 0;
    const listener = createExitConfirmationInputListener({
      timeoutMs: 2500,
      setNoticeLine: (line) => {
        notice = line;
      },
      requestRender: () => {},
      exit: () => {
        exitCount += 1;
      },
    });

    try {
      expect(listener("\u001b[99;5:1u")).toEqual({ consume: true });
      expect(listener("\u001b[99;5:3u")).toEqual({ consume: true });

      expect(notice).toBe("press Ctrl-C again to exit.");
      expect(exitCount).toBe(0);

      expect(listener("\u001b[99;5:1u")).toEqual({ consume: true });
      expect(exitCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the Ctrl-C exit notice after the timeout", () => {
    vi.useFakeTimers();
    let notice: string | undefined;
    let exitCount = 0;
    const listener = createExitConfirmationInputListener({
      timeoutMs: 2500,
      setNoticeLine: (line) => {
        notice = line;
      },
      requestRender: () => {},
      exit: () => {
        exitCount += 1;
      },
    });

    try {
      listener("\u0003");
      vi.advanceTimersByTime(2500);

      expect(notice).toBeUndefined();

      listener("\u0003");
      expect(exitCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders agent message metadata under the agent response", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [agentMessage("Sure, I can help.", "qwen/qwen3-coder:free · 1.4 sec")],
      "repo",
      "model [provider]"
    );

    const output = app.render(60).join("\n");

    expect(output).toContain(" Sure, I can help.");
    expect(output).toContain(" ─────────────────────────────────");
    expect(output).toContain(" ↳ qwen/qwen3-coder:free · 1.4 sec");
  });

  it("renders one blank line between chat messages", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 12;
    const app = new ChatLayout(
      terminal,
      [systemMessage("First"), agentMessage("Second", "model · 1.0 sec")],
      "repo",
      "model [provider]"
    );

    const lines = app.render(60);
    const firstIndex = lines.findIndex((line) => line.includes("System:"));
    const firstBodyIndex = lines.findIndex((line) => line.includes("First"));
    const secondIndex = lines.findIndex((line) => line.includes("Second"));

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(firstBodyIndex).toBe(firstIndex + 1);
    expect(secondIndex).toBe(firstBodyIndex + 2);
    expect(lines[firstBodyIndex + 1]?.trim()).toBe("");
  });

  it("renders multiline agent Markdown without prefix indentation", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [agentMessage("- package.json | ./package.json | 3\n- readme.md | ./readme.md | 1")],
      "repo",
      "model [provider]"
    );

    const output = app.render(80).join("\n");

    expect(output).toContain(" - package.json | ./package.json | 3");
    expect(output).toContain(" - readme.md | ./readme.md | 1");
    expect(output).not.toContain("Agent:");
    expect(output).not.toContain("       - readme.md");
  });

  it("renders agent fenced code blocks without fence markers", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [agentMessage("```typescript\nconst answer: number = 42;\n```")],
      "repo",
      "model [provider]"
    );

    const output = app.render(80).join("\n");

    expect(output).toContain("const answer: number = 42;");
    expect(output).not.toContain("│ const answer");
    expect(output).not.toContain("```");
  });

  it("colors agent fenced code blocks when color is enabled", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      const app = new ChatLayout(
        new FakeTerminal(),
        [agentMessage("```typescript\nconst answer: number = 42;\n```")],
        "repo",
        "model [provider]"
      );

      const output = app.render(80).join("\n");

      expect(output).toContain("\u001b[48;5;235m");
      expect(output).not.toContain("\u001b[48;5;236m");
      expect(output).toContain("\u001b[");
      expect(output).toContain("const");
      expect(output).not.toContain("│ const");
      expect(output).not.toContain("```");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("renders markdown fenced as markdown instead of raw code", () => {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";

    try {
      const app = new ChatLayout(
        new FakeTerminal(),
        [agentMessage("The content is:\n\n```markdown\n# Title\n\n## Details\n\n**Bold item**\n```")],
        "repo",
        "model [provider]"
      );

      const output = app.render(80).join("\n");

      expect(output).toContain("Title");
      expect(output).toContain("Details");
      expect(output).toContain("\u001b[1mBold item\u001b[22m");
      expect(output).not.toContain("# Title");
      expect(output).not.toContain("```");
      expect(output).not.toContain("\u001b[48;5;235m");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });

  it("scrolls chat history inside the TUI with page keys and mouse wheel", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 7;
    const app = new ChatLayout(
      terminal,
      Array.from({ length: 12 }, (_, index) => systemMessage(`Message ${index + 1}`)),
      "repo",
      "model [provider]"
    );

    const bottomOutput = app.render(60).join("\n");
    expect(bottomOutput).toContain("Message 12");

    app.handleInput("\u001b[5~");
    const scrolledOutput = app.render(60).join("\n");

    expect(scrolledOutput).not.toContain("Message 12");
    expect(scrolledOutput).toContain("Message 11");

    app.handleInput("\u001b[6~");
    const bottomAgainOutput = app.render(60).join("\n");

    expect(bottomAgainOutput).toContain("Message 12");

    app.handleInput("\u001b[<64;1;1M");
    const wheelScrolledOutput = app.render(60).join("\n");

    expect(wheelScrolledOutput).not.toContain("Message 12");
    expect(wheelScrolledOutput).toContain("Message 11");

    app.handleInput("\u001b[<65;1;1M");
    const wheelBottomOutput = app.render(60).join("\n");

    expect(wheelBottomOutput).toContain("Message 12");

    app.handleInput("\u001b[A");
    const arrowOutput = app.render(60).join("\n");

    expect(arrowOutput).toContain("Message 12");
  });

  it("appends user messages and calls the submit handler", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    let submitted = "";
    app.setSubmitMessage((message) => {
      submitted = message;
    });
    app.setInputValue("hello");

    app.handleInput("\n");
    const output = app.render(60).join("\n");

    expect(output).toContain("▌ hello");
    expect(submitted).toBe("hello");
  });

  it("routes slash commands to the command handler", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    let submittedCommand = "";
    let submittedMessage = "";
    app.setSubmitCommand((command) => {
      submittedCommand = command;
    });
    app.setSubmitMessage((message) => {
      submittedMessage = message;
    });
    app.setInputValue("/kb status");

    app.handleInput("\n");
    const output = app.render(60).join("\n");

    expect(output).toContain("▌ /kb status");
    expect(submittedCommand).toBe("/kb status");
    expect(submittedMessage).toBe("");
  });

  it("shows slash command suggestions while typing a command prefix", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 14;
    const app = new ChatLayout(terminal, [], "repo", "model [provider]");
    app.setInputValue("/k");

    const output = app.render(80).join("\n");

    expect(output).toContain("slash commands");
    expect(output).toContain("> /kb status — show non-clean knowledge files");
    expect(output).toContain("Tab complete · ↑↓ choose");
  });

  it("completes the active slash command suggestion with Tab", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 14;
    const app = new ChatLayout(terminal, [], "repo", "model [provider]");
    app.setInputValue("/k");

    app.handleInput("\t");
    const output = app.render(80).join("\n");

    expect(output).toContain("│ > /kb status");
    expect(output).toContain("/kb status\u001b[7m");
    expect(output).not.toContain("/\u001b[7mkb status");
  });

  it("renders user messages with top and bottom padding", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    app.setInputValue("hello");

    app.handleInput("\n");
    const lines = app.render(60);
    const messageIndex = lines.findIndex((line) => line.includes("▌ hello"));

    expect(lines[messageIndex - 1]).toContain("▌");
    expect(lines[messageIndex + 1]).toContain("▌");
  });

  it("renders chat modal messages with numbered actions", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "warning",
          title: "No KB found",
          actions: [
            { label: "Create KB now" },
            { label: "Skip creation - will exit, kb is required" },
            { label: "Add custom instructions for KB creation" },
          ],
        }),
      ],
      "repo",
      "model [provider]"
    );

    const output = app.render(80).join("\n");

    expect(output).toContain("⚠️  No KB found:");
    expect(output).toContain("> 1) Create KB now");
    expect(output).toContain("  2) Skip creation - will exit, kb is required");
    expect(output).toContain("  3) Add custom instructions for KB creation");
    expect(output).toContain("↑↓ navigate   Enter select   Esc cancel");
    expect(output).not.toContain("┌");
    expect(output).not.toContain("└");
  });

  it("renders info chat modal messages with body text", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "info",
          title: "Choose setup",
          body: "This will create project knowledge files.",
          actions: [{ label: "Continue" }],
        }),
      ],
      "repo",
      "model [provider]"
    );

    const output = app.render(80).join("\n");

    expect(output).toContain("ℹ️  Choose setup:");
    expect(output).toContain("This will create project knowledge files.");
    expect(output).toContain("> 1) Continue");
    expect(output).not.toContain("┌");
    expect(output).not.toContain("└");
  });

  it("moves the active chat modal action with arrow keys", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "warning",
          title: "No KB found",
          actions: [{ label: "Create KB now" }, { label: "Skip creation" }],
        }),
      ],
      "repo",
      "model [provider]"
    );

    app.handleInput("\u001b[B");
    const output = app.render(80).join("\n");

    expect(output).toContain("  1) Create KB now");
    expect(output).toContain("> 2) Skip creation");
  });

  it("submits the active chat modal action on enter", () => {
    let submitted = "";
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "warning",
          title: "No KB found",
          actions: [{ label: "Create KB now" }, { label: "Skip creation" }],
        }),
      ],
      "repo",
      "model [provider]"
    );
    app.setSubmitMessage((message) => {
      submitted = message;
    });

    app.handleInput("\u001b[B");
    app.handleInput("\n");
    const output = app.render(80).join("\n");

    expect(output).toContain("▌ Skip creation");
    expect(submitted).toBe("Skip creation");
  });

  it("submits cancel when Esc is pressed with an active chat modal", () => {
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "warning",
          title: "No KB found",
          actions: [{ label: "Create KB now" }, { label: "Skip creation" }],
        }),
      ],
      "repo",
      "model [provider]"
    );

    app.handleInput("\u001b");
    const output = app.render(80).join("\n");

    expect(output).toContain("▌ Cancel");
    expect(output).not.toContain("chat is not wired yet");
  });

  it("busy indicator rotates activity text", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    const busy = new BusyIndicator(
      app,
      { requestRender() {} },
      {
        status: "working",
        promptHint: "press Esc to stop",
        activities: ["Doing one...", "Doing two..."],
      }
    );

    busy.start();
    const output = app.render(60).join("\n");
    busy.stop();

    expect(output).toContain("Doing one...");
    expect(output).toContain("press Esc to stop");
  });

  it("shows a KB status modal when the project has no KB", () => {
    const messages = getKnowledgeStatusMessages({
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: false,
      kbIsDirectory: false,
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default",
      cachePathSource: "default",
    });
    const terminal = new FakeTerminal();
    terminal.rows = 14;
    const app = new ChatLayout(terminal, messages, "repo", "model [provider]");

    const output = app.render(80).join("\n");

    expect(output).toContain("KB status:  topchester-kb [missing]");
    expect(output).toContain("⚠️  No KB found:");
    expect(output).toContain("Topchester needs a project knowledge base before normal coding can start.");
    expect(output).toContain("> 1) Create KB now");
    expect(output).toContain("  2) Exit");
    expect(output).not.toContain("Add custom KB setup notes");
  });

  it("reports an empty KB folder in the startup status message", () => {
    const messages = getKnowledgeStatusMessages({
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: true,
      kbIsDirectory: true,
      cacheExists: false,
      cacheIsDirectory: false,
      kbContentState: "empty",
      kbPathSource: "default",
      cachePathSource: "default",
    });
    const app = new ChatLayout(new FakeTerminal(), messages, "repo", "model [provider]");

    const output = app.render(80).join("\n");

    expect(output).toContain("KB status:  topchester-kb [empty]");
    expect(output).not.toContain("KB status:  topchester-kb [ok] (default)");
  });

  it("labels custom KB paths in TUI status messages", () => {
    const messages = getKnowledgeStatusMessages({
      workspaceRoot: "/repo",
      kbPath: "/external/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: true,
      kbIsDirectory: true,
      cacheExists: false,
      cacheIsDirectory: false,
      kbContentState: "empty",
      kbPathSource: "env",
      cachePathSource: "default",
    });
    const app = new ChatLayout(new FakeTerminal(), messages, "repo", "model [provider]");

    const output = app.render(80).join("\n");

    expect(output).toContain("KB status:  /external/topchester-kb [empty] (custom)");
  });

  it("keeps external KB paths absolute in TUI status messages", () => {
    expect(
      formatKnowledgePathStatus({
        workspaceRoot: "/repo",
        kbPath: "/external/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: true,
        kbIsDirectory: true,
        cacheExists: false,
        cacheIsDirectory: false,
        kbContentState: "empty",
        kbPathSource: "env",
        cachePathSource: "default",
      })
    ).toBe(" /external/topchester-kb [empty]");
  });

  it("hides the KB status modal when the dev flag disables it", () => {
    const messages = getKnowledgeStatusMessages(
      {
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: false,
        kbIsDirectory: false,
        cacheExists: false,
        cacheIsDirectory: false,
        kbPathSource: "default",
        cachePathSource: "default",
      },
      new Set(["disable-kb-check-modal"])
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("system");
  });

  it("exits when the active modal Exit action is selected", () => {
    let exited = false;
    const app = new ChatLayout(
      new FakeTerminal(),
      [
        modalMessage({
          tone: "warning",
          title: "No KB found",
          actions: [{ label: "Create KB now" }, { label: "Exit" }],
        }),
      ],
      "repo",
      "model [provider]",
      () => {
        exited = true;
      }
    );

    app.handleInput("\u001b[B");
    app.handleInput("\n");

    expect(exited).toBe(true);
  });

  it("persists fresh static startup rows in visible order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tui-session-"));
    const context = createTestContext(workspace);
    const messages = [systemMessage("Startup one"), systemMessage("Startup two")];

    await new TopchesterTuiShell(context, undefined, { initialMessages: messages }).render();

    const sessionDirs = await readSessionDirs(workspace);
    expect(sessionDirs).toHaveLength(1);
    const lines = await readSessionLines(workspace, sessionDirs[0]!);
    expect(lines.map((line) => ({ kind: line.kind, role: line.role, text: line.text }))).toEqual([
      { kind: "message", role: "system", text: "Startup one" },
      { kind: "message", role: "system", text: "Startup two" },
    ]);
  });

  it("converts runtime events to structured persisted payloads", () => {
    const status = {
      workspaceRoot: "/repo",
      kbPath: "/repo/topchester-kb",
      cachePath: "/repo/.agents/topchester-kb-cache",
      kbExists: false,
      kbIsDirectory: false,
      cacheExists: false,
      cacheIsDirectory: false,
      kbPathSource: "default" as const,
      cachePathSource: "default" as const,
    };

    expect(runtimeEventToSessionPayload(agentEvent.assistantMessage("Done", "model · 1 sec"))).toEqual({
      kind: "message",
      role: "assistant",
      text: "Done",
      meta: "model · 1 sec",
    });
    expect(
      runtimeEventToSessionPayload(
        agentEvent.toolCall({ tool: "read_file", args: { path: "README.md" } }, "read_file: README.md")
      )
    ).toEqual({
      kind: "tool_call",
      label: "read_file: README.md",
      call: { tool: "read_file", args: { path: "README.md" } },
    });
    expect(runtimeEventToSessionPayload(agentEvent.knowledgeStatus(status))).toBeUndefined();
    expect(
      runtimeEventToSessionPayload(
        agentEvent.choice({ tone: "warning", title: "No KB found", body: "Create one?", actions: [{ label: "Exit" }] })
      )
    ).toEqual({
      kind: "choice",
      tone: "warning",
      title: "No KB found",
      body: "Create one?",
      actions: [{ label: "Exit" }],
    });
    expect(runtimeEventToSessionPayload(agentEvent.status("ready"))).toEqual({
      kind: "status",
      status: "ready",
    });
  });

  it("does not turn successful startup checks into visible ready messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-ready-check-"));
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkAgent();

    expect(events).toEqual([agentEvent.status("ready")]);
    expect(events.flatMap((event) => (event.type === "message" ? [event.text] : []))).not.toContain("ready");
  });

  it("marks slash-command submissions as visible-only command input", () => {
    expect(slashCommandToSessionPayload("/kb status")).toEqual({
      kind: "message",
      role: "user",
      text: "/kb status",
      meta: { source: "slash_command", visibleOnly: true },
    });
  });

  it("filters resumed model context to normal user and assistant turns only", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-resume-context-"));
    const session = await createSession(workspace);
    const capturedPrompts: string[] = [];
    const context = {
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt?: string; purpose?: string }) {
          if (request.purpose === "agent.primary") {
            capturedPrompts.push(request.prompt ?? "");
          }

          return {
            text: "assistant after resume",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    };

    await session.append({ kind: "message", role: "system", text: "startup row" });
    await session.append({ kind: "message", role: "user", text: "normal old user" });
    await session.append({ kind: "message", role: "assistant", text: "normal old assistant" });
    await session.append(slashCommandToSessionPayload("/kb status"));
    await session.append({ kind: "message", role: "system", text: "slash command output" });
    await session.append({
      kind: "tool_call",
      label: "read_file: README.md",
      call: { tool: "read_file", args: { path: "README.md" } },
    });
    await session.append({
      kind: "knowledge_status",
      status: {
        workspaceRoot: workspace,
        kbPath: join(workspace, "topchester-kb"),
        cachePath: join(workspace, ".agents", "topchester-kb-cache"),
        kbExists: false,
        kbIsDirectory: false,
        cacheExists: false,
        cacheIsDirectory: false,
        kbPathSource: "default",
        cachePathSource: "default",
      },
    });
    await session.append({
      kind: "choice",
      tone: "warning",
      title: "No KB found",
      body: "Create one?",
      actions: [{ label: "Create KB now", value: "/kb init" }],
    });
    await session.append({ kind: "message", role: "user", text: "Create KB now" });
    await session.append({ kind: "status", status: "ready" });

    const loaded = await loadSession(workspace, session.sessionId);
    const rehydrated = rehydrateSession(loaded.events);
    const app = new ChatLayout(new FakeTerminal(), rehydrated.messages, "repo", "fake-agent");

    await new TopchesterAgentRuntime(context).submitMessage(app.getConversationTurns(), "new prompt", undefined);

    expect(capturedPrompts).toEqual([
      ["User: normal old user", "Assistant: normal old assistant", "User: new prompt"].join("\n\n"),
    ]);
    expect(capturedPrompts[0]).not.toContain("startup row");
    expect(capturedPrompts[0]).not.toContain("/kb status");
    expect(capturedPrompts[0]).not.toContain("slash command output");
    expect(capturedPrompts[0]).not.toContain("read_file: README.md");
    expect(capturedPrompts[0]).not.toContain("No KB found");
    expect(capturedPrompts[0]).not.toContain("Create KB now");
    expect(capturedPrompts[0]).not.toContain("ready");
  });

  it("warns once when startup persistence fails without recursively persisting the warning", async () => {
    const messages = [systemMessage("Startup one"), systemMessage("Startup two")];
    let appendCalls = 0;
    const session = {
      async append() {
        appendCalls += 1;
        throw new Error("disk is full");
      },
    } as unknown as SessionHandle;

    await persistMessagesWithWarning(session, messages);

    expect(appendCalls).toBe(1);
    expect(messages.flatMap((message) => ("text" in message ? [message.text] : []))).toEqual([
      "Startup one",
      "Startup two",
      "Session save failed: disk is full",
    ]);
  });

  it("awaits runtime event appends in runtime event processing order before returning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-await-"));
    const context = createTestContext(workspace);
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    const appendStarted: string[] = [];
    const appendFinished: string[] = [];
    let releaseFirstAppend: (() => void) | undefined;
    let releaseSecondAppend: (() => void) | undefined;
    let applyFinished = false;
    const shell = new TopchesterTuiShell(context, undefined, {
      session: {
        async append(payload: SessionEventPayload) {
          const label = payload.kind === "message" ? payload.text : payload.kind;
          appendStarted.push(label);
          await new Promise<void>((resolve) => {
            if (appendStarted.length === 1) {
              releaseFirstAppend = resolve;
            } else {
              releaseSecondAppend = resolve;
            }
          });
          appendFinished.push(label);
        },
      } as unknown as SessionHandle,
    });

    const applying = (shell as unknown as { applyRuntimeEvents(app: ChatLayout, events: unknown[]): Promise<void> })
      .applyRuntimeEvents(app, [agentEvent.assistantMessage("First"), agentEvent.systemMessage("Second")])
      .then(() => {
        applyFinished = true;
      });
    await Promise.resolve();

    expect(appendStarted).toEqual(["First"]);
    expect(applyFinished).toBe(false);

    releaseFirstAppend?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendStarted).toEqual(["First", "Second"]);
    expect(applyFinished).toBe(false);

    releaseSecondAppend?.();
    await applying;

    expect(appendFinished).toEqual(["First", "Second"]);
    expect(applyFinished).toBe(true);
  });

  it("adds runtime append failure warnings before runtime event processing returns without recursive persistence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-warning-"));
    const context = createTestContext(workspace);
    const messages: ChatMessage[] = [];
    const app = new ChatLayout(new FakeTerminal(), messages, "repo", "model [provider]");
    let appendCalls = 0;
    const shell = new TopchesterTuiShell(context, undefined, {
      session: {
        async append() {
          appendCalls += 1;
          throw new Error("disk is full");
        },
      } as unknown as SessionHandle,
    });

    await (
      shell as unknown as { applyRuntimeEvents(app: ChatLayout, events: unknown[]): Promise<void> }
    ).applyRuntimeEvents(app, [agentEvent.assistantMessage("Saved later")]);

    expect(appendCalls).toBe(1);
    expect(messages.map((message) => ("text" in message ? message.text : message.title))).toEqual([
      "Saved later",
      "Session save failed: disk is full",
    ]);
  });

  it("keeps ChatLayout and AgentRuntime free of session persistence ownership", async () => {
    const [layoutSource, runtimeSource] = await Promise.all([
      readFile(join(process.cwd(), "src/tui/layout.ts"), "utf8"),
      readFile(join(process.cwd(), "src/agent/runtime.ts"), "utf8"),
    ]);

    expect(layoutSource).not.toMatch(
      /node:fs|from ".*session|append\(|loadSession|createSession|getTopchesterSessionsPath/u
    );
    expect(runtimeSource).not.toMatch(
      /node:fs|from ".*session|append\(|loadSession|createSession|getTopchesterSessionsPath/u
    );
  });
});

function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
    config: {},
    devFlags: new Set(["disable-kb-check-modal"]),
    modelGateway: {
      async generateText() {
        return {
          text: "ready",
          providerId: "fake",
          modelId: "fake-agent",
          purpose: "agent.primary" as const,
        };
      },
    } as unknown as AppContext["modelGateway"],
    logger: {
      debug() {},
      trace() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as AppContext["logger"],
  };
}

async function readSessionDirs(workspace: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(getTopchesterSessionsPath(workspace))).sort();
}

async function readSessionLines(workspace: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(getTopchesterSessionsPath(workspace), sessionId, "events.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
