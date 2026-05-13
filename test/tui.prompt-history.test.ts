import { describe, expect, it } from "vitest";
import { type Terminal } from "@earendil-works/pi-tui";
import { ChatLayout } from "../src/tui/layout.js";
import { modalMessage, systemMessage } from "../src/tui/messages.js";

class FakeTerminal implements Terminal {
  columns = 60;
  rows = 10;
  kittyProtocolActive = false;

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

describe("TUI prompt history", () => {
  it("recalls submitted prompts and restores the draft", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");

    submit(app, "first");
    submit(app, "second");
    app.setInputValue("draft");

    app.handleInput("\u001b[A");
    expect(promptText(app)).toContain("> second");

    app.handleInput("\u001b[A");
    expect(promptText(app)).toContain("> first");

    app.handleInput("\u001b[B");
    expect(promptText(app)).toContain("> second");

    app.handleInput("\u001b[B");
    expect(promptText(app)).toContain("> draft");
  });

  it("recalls submitted slash commands", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");

    submit(app, "/kb status");

    app.handleInput("\u001b[A");

    expect(promptText(app)).toContain("> /kb status");
  });

  it("keeps slash suggestion arrows ahead of prompt history", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    submit(app, "remembered");
    app.setInputValue("/kb");

    app.handleInput("\u001b[B");
    const output = app.render(80).join("\n");

    expect(output).toContain("> /kb compile");
    expect(promptText(app)).toContain("> /kb");
  });

  it("keeps modal arrows ahead of prompt history", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    submit(app, "remembered");
    app.addMessage(
      modalMessage({
        tone: "warning",
        title: "No KB found",
        actions: [{ label: "Create KB now" }, { label: "Skip creation" }],
      })
    );

    app.handleInput("\u001b[B");
    const output = app.render(80).join("\n");

    expect(output).toContain("> 2) Skip creation");
    expect(output).not.toContain("> remembered");
  });

  it("keeps prompt history disabled while a prompt hint is shown", () => {
    const app = new ChatLayout(new FakeTerminal(), [], "repo", "model [provider]");
    submit(app, "remembered");
    app.setPromptHint("press Esc to stop");

    app.handleInput("\u001b[A");
    const output = app.render(80).join("\n");

    expect(output).toContain("press Esc to stop");
    expect(output).not.toContain("> remembered");
  });

  it("keeps page keys and mouse wheel for thread scrolling", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 7;
    const app = new ChatLayout(
      terminal,
      Array.from({ length: 12 }, (_, index) => systemMessage(`Message ${index + 1}`)),
      "repo",
      "model [provider]"
    );

    expect(app.render(60).join("\n")).toContain("Message 12");

    app.handleInput("\u001b[5~");
    expect(app.render(60).join("\n")).not.toContain("Message 12");

    app.handleInput("\u001b[6~");
    expect(app.render(60).join("\n")).toContain("Message 12");

    app.handleInput("\u001b[<64;1;1M");
    expect(app.render(60).join("\n")).not.toContain("Message 12");

    app.handleInput("\u001b[<65;1;1M");
    expect(app.render(60).join("\n")).toContain("Message 12");
  });

  it("does not use bare arrows for thread scrolling in normal prompt mode", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 7;
    const app = new ChatLayout(
      terminal,
      Array.from({ length: 12 }, (_, index) => systemMessage(`Message ${index + 1}`)),
      "repo",
      "model [provider]"
    );

    app.handleInput("\u001b[A");

    expect(app.render(60).join("\n")).toContain("Message 12");
  });
});

function submit(app: ChatLayout, value: string): void {
  app.setInputValue(value);
  app.handleInput("\n");
}

function promptLine(app: ChatLayout): string {
  return app.render(80).at(-3) ?? "";
}

function promptText(app: ChatLayout): string {
  return promptLine(app).replace(/\u001b\[[0-9;]*m/g, "");
}
