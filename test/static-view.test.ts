import { describe, expect, it } from "vite-plus/test";
import { renderStaticView } from "../src/chat/static-view.js";

describe("static chat view", () => {
  it("renders semantic transcript and status without terminal control bytes", () => {
    const output = renderStaticView({
      transcript: [
        { kind: "user", persistence: "session", text: "hello" },
        { kind: "assistant", persistence: "session", text: "world", meta: "fixture-model" },
        { kind: "reasoning", persistence: "display", text: "thinking" },
      ],
      workspaceLabel: "repo",
      modelLabel: "fixture [fake]",
      taskPlan: {
        updatedAt: "2026-07-17T00:00:00.000Z",
        items: [{ text: "Verify", status: "in_progress" }],
      },
    });

    expect(output).toContain("▌ hello");
    expect(output).toContain("world");
    expect(output).toContain("↳ fixture-model");
    expect(output).toContain("◐ Verify");
    expect(output).toContain("● ready ·  repo · fixture [fake]");
    expect(output).not.toContain("\u001b");
  });
});
