import { describe, expect, it } from "vite-plus/test";
import { fingerprintPromptSegments, renderPromptSegments } from "../src/agent/context/prompt.js";

describe("canonical prompt segments", () => {
  it("preserves legacy double-newline rendering byte for byte", () => {
    const segments = [
      { kind: "conversation", text: "User: hello", retention: "required" },
      { kind: "tool_result", text: "Tool result: ok", retention: "replaceable", associationId: "call-1" },
      { kind: "continuation", text: "Continue.", retention: "required", associationId: "call-1" },
    ] as const;
    expect(renderPromptSegments(segments)).toBe("User: hello\n\nTool result: ok\n\nContinue.");
    expect(fingerprintPromptSegments(segments)).not.toBe(
      fingerprintPromptSegments([{ ...segments[0], text: "User: changed" }, ...segments.slice(1)])
    );
  });

  it("preserves the legacy knowledge-pack boundary with an explicit separator", () => {
    expect(
      renderPromptSegments([
        { kind: "knowledge", text: "Knowledge pack\n\nConversation:", retention: "required" },
        { kind: "conversation", text: "User: hello", retention: "required", separatorBefore: "\n" },
        { kind: "hook_context", text: "Hook context", retention: "required" },
      ])
    ).toBe("Knowledge pack\n\nConversation:\nUser: hello\n\nHook context");
  });
});
