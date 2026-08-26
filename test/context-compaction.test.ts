import { describe, expect, it } from "vite-plus/test";
import {
  compactConversationDeterministically,
  isEffectiveCompaction,
  prunePromptSegments,
} from "../src/agent/context/compaction.js";

describe("context compaction", () => {
  it("prunes only replaceable old tool results and retains deterministic evidence", () => {
    const large = "output ".repeat(4000);
    const result = prunePromptSegments(
      [
        {
          kind: "tool_result",
          text: large,
          retention: "replaceable",
          associationId: "call-1",
          metadata: { toolName: "read_file", path: "src/app.ts" },
        },
        { kind: "current_user", text: "keep this request", retention: "required" },
      ],
      { targetTokens: 100, keepRecentTokens: 10 }
    );
    expect(result.segments[0]?.text).toContain("read_file src/app.ts; association call-1: completed; output pruned");
    expect(result.prunedAssociations).toEqual(["call-1"]);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("summarizes older turns while preserving the newest two complete pairs verbatim", () => {
    const turns = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index}: ${index === 0 ? "constraint ABC-123 " : ""}${"detail ".repeat(200)}`,
    }));
    const result = compactConversationDeterministically(turns, { keepRecentTokens: 100 });
    expect(result.projection.summary).toContain("ABC-123");
    expect(result.projection.segments).toHaveLength(4);
    expect(isEffectiveCompaction(result.beforeTokens, result.afterTokens)).toBe(true);
  });
});
