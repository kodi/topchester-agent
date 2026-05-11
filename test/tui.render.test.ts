import { describe, expect, it, vi } from "vitest";
import {
  ChatLayout,
  BusyIndicator,
  enterAlternateScreen,
  exitAlternateScreen,
  getKnowledgeStatusMessages,
} from "../src/tui/index.js";
import { createExitConfirmationInputListener } from "../src/tui/shell.js";
import { agentMessage, modalMessage, systemMessage } from "../src/tui/messages.js";
import { type Terminal } from "@earendil-works/pi-tui";

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
    expect(output).toContain("status: ready · folder: repo · model: model [provider]");
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
    expect(output).toContain(" qwen/qwen3-coder:free · 1.4 sec");
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

  it("scrolls chat history inside the TUI with page keys and alternate-scroll arrows", () => {
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

    app.handleInput("\u001b[A");
    const arrowScrolledOutput = app.render(60).join("\n");

    expect(arrowScrolledOutput).not.toContain("Message 12");
    expect(arrowScrolledOutput).toContain("Message 11");

    app.handleInput("\u001b[B");
    const arrowBottomOutput = app.render(60).join("\n");

    expect(arrowBottomOutput).toContain("Message 12");
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

    expect(output).toContain(" You: hello");
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

    expect(output).toContain(" You: /kb status");
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
    expect(output).toContain("> /kb status — show project knowledge base status");
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
    const messageIndex = lines.findIndex((line) => line.includes("You: hello"));

    expect(messageIndex).toBeGreaterThan(0);
    expect(lines[messageIndex - 1]?.trim()).toBe("");
    expect(lines[messageIndex + 1]?.trim()).toBe("");
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

    expect(output).toContain(" You: Skip creation");
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

    expect(output).toContain(" You: Cancel");
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

    expect(output).toContain("KB status: /repo/topchester-kb [missing] (default)");
    expect(output).toContain("⚠️  No KB found:");
    expect(output).toContain("Topchester needs a project knowledge base before normal coding can start.");
    expect(output).toContain("> 1) Create KB now");
    expect(output).toContain("  2) Exit");
    expect(output).not.toContain("Add custom KB setup notes");
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
});
