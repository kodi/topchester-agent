import { describe, expect, it } from "vite-plus/test";
import { formatContextDiagnostics, formatContextStatusBar } from "../src/chat/context-status.js";
import { type ContextStatus } from "../src/agent/context/types.js";

function fixture(known: boolean): ContextStatus {
  const route = { providerId: "vibeproxy", baseURL: "http://127.0.0.1:8317/v1", modelId: "gpt-5.4" };
  return {
    route,
    usage: {
      promptTokens: 74_120,
      trailingEstimatedTokens: 0,
      source: "local-estimate",
      estimated: true,
      route,
      asOfModelCall: 1,
      requestBaseFingerprint: "fixture",
      observedAt: "2026-08-26T00:00:00.000Z",
    },
    budget: {
      capacity: known
        ? { contextWindow: 128_000, source: "config", confidence: "authoritative" }
        : { source: "unknown", confidence: "unknown" },
      usedTokens: 74_120,
      ...(known
        ? {
            hardPromptBudget: 111_616,
            compactAtTokens: 88_874,
            targetTokens: 44_646,
            reserveTokens: 16_384,
            rawRemainingTokens: 37_496,
            safeRemainingTokens: 33_496,
          }
        : {}),
      uncertaintyTokens: known ? 4_000 : 4_000,
    },
    compactionsThisSession: 1,
    compactionsThisTurn: 0,
  };
}

describe("context status formatting", () => {
  it("never fabricates a percentage for unknown capacity", () => {
    expect(formatContextStatusBar(fixture(false), 200)).toBe("ctx ~74k/?");
    expect(formatContextDiagnostics(fixture(false), true)).toContain("capacity: unknown tokens (unknown, unknown)");
  });

  it("collapses detail by width while retaining actionable severity", () => {
    expect(formatContextStatusBar(fixture(true), 200)).toContain("ctx ~74k/128k · 58% · 33k safe");
    expect(formatContextStatusBar(fixture(true), 100)).toBe("ctx 58% · 33k safe");
    expect(formatContextStatusBar(fixture(true), 80)).toBe("ctx 58%");
    expect(formatContextDiagnostics(fixture(true), true)).toContain("hard prompt budget: 111,616 tokens");
    expect(formatContextDiagnostics(fixture(true), true)).toContain("raw remaining: 37,496 tokens");
  });
});
