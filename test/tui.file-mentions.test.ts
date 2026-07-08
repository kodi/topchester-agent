import { describe, expect, it } from "vitest";
import { applyMentionCompletion, findActiveMention } from "../src/tui/file-mentions.js";

describe("file mention parsing", () => {
  it("finds an @ mention at the start of the prompt", () => {
    expect(findActiveMention("@src/tui", 8)).toEqual({ start: 0, end: 8, query: "src/tui" });
  });

  it("finds an @ mention after whitespace", () => {
    expect(findActiveMention("read @layout", 12)).toEqual({ start: 5, end: 12, query: "layout" });
  });

  it("ignores mid-word @ tokens", () => {
    expect(findActiveMention("mail me@example.com", 15)).toBeUndefined();
  });

  it("tracks the active mention when the cursor is inside the token", () => {
    expect(findActiveMention("open @src/tui/layout.ts now", 13)).toEqual({
      start: 5,
      end: 23,
      query: "src/tui",
    });
  });

  it("finds mentions in multi-line prompts", () => {
    const value = "first line\ninspect @layout";

    expect(findActiveMention(value, value.length)).toEqual({ start: 19, end: 26, query: "layout" });
  });

  it("returns no mention when the cursor is outside the token", () => {
    expect(findActiveMention("inspect @layout now", 19)).toBeUndefined();
  });

  it("completes files with a trailing space and updates the cursor", () => {
    const value = "read @lay now";
    const mention = findActiveMention(value, 9);

    expect(mention).toBeDefined();
    expect(applyMentionCompletion(value, mention!, "src/tui/layout.ts", false)).toEqual({
      value: "read @src/tui/layout.ts now",
      cursor: 24,
    });
  });

  it("completes directories with a trailing slash and updates the cursor", () => {
    const value = "read @src";
    const mention = findActiveMention(value, value.length);

    expect(mention).toBeDefined();
    expect(applyMentionCompletion(value, mention!, "src/tui", true)).toEqual({
      value: "read @src/tui/",
      cursor: 14,
    });
  });
});
