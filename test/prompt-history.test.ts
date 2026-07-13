import { describe, expect, it } from "vite-plus/test";
import { PromptHistory } from "../src/tui/prompt-history.js";

describe("PromptHistory", () => {
  it("walks from newest to oldest and clamps at the oldest prompt", () => {
    const history = new PromptHistory();
    history.add("first");
    history.add("second");

    expect(history.previous("draft")).toBe("second");
    expect(history.previous("draft")).toBe("first");
    expect(history.previous("draft")).toBe("first");
  });

  it("walks back toward newest and restores the saved draft", () => {
    const history = new PromptHistory();
    history.add("first");
    history.add("second");

    expect(history.previous("draft")).toBe("second");
    expect(history.previous("draft")).toBe("first");
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("draft");
    expect(history.next()).toBeUndefined();
  });

  it("skips empty prompts and consecutive duplicates", () => {
    const history = new PromptHistory();
    history.add("");
    history.add("   ");
    history.add("same");
    history.add("same");

    expect(history.previous("draft")).toBe("same");
    expect(history.previous("draft")).toBe("same");
  });

  it("keeps non-consecutive duplicates", () => {
    const history = new PromptHistory();
    history.add("same");
    history.add("other");
    history.add("same");

    expect(history.previous("")).toBe("same");
    expect(history.previous("")).toBe("other");
    expect(history.previous("")).toBe("same");
  });

  it("caps the prompt list at the configured maximum", () => {
    const history = new PromptHistory(2);
    history.add("first");
    history.add("second");
    history.add("third");

    expect(history.previous("")).toBe("third");
    expect(history.previous("")).toBe("second");
    expect(history.previous("")).toBe("second");
  });

  it("saves a fresh draft after browsing resets", () => {
    const history = new PromptHistory();
    history.add("first");

    expect(history.previous("old draft")).toBe("first");
    history.resetBrowsing();
    expect(history.previous("new draft")).toBe("first");
    expect(history.next()).toBe("new draft");
  });
});
