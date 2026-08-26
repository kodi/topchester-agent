import { describe, expect, it } from "vite-plus/test";
import {
  contextRouteKey,
  deriveContextBudget,
  normalizeContextRoute,
  resolveContextCapacity,
} from "../src/agent/context/capacity.js";
import { DEFAULT_CONTEXT_POLICY } from "../src/agent/context/types.js";

describe("route-aware context capacity", () => {
  it("isolates the same model id by provider and normalized base URL", () => {
    const direct = contextRouteKey({ providerId: "Codex", baseURL: "https://Example.COM/v1/", modelId: "gpt-5.4" });
    const proxy = contextRouteKey({ providerId: "vibeproxy", baseURL: "http://127.0.0.1:8317/v1", modelId: "gpt-5.4" });
    expect(direct).not.toBe(proxy);
    expect(
      normalizeContextRoute({ providerId: "Codex ", baseURL: "https://Example.COM/v1/", modelId: "gpt-5.4" })
    ).toEqual({
      providerId: "codex",
      baseURL: "https://example.com/v1",
      modelId: "gpt-5.4",
    });
  });

  it("keeps explicit config authoritative and applies learned ceilings only as non-raising caps", () => {
    const config = { contextWindow: 128_000, source: "config", confidence: "authoritative" } as const;
    expect(
      resolveContextCapacity({
        config,
        learned: { maxInputTokens: 64_000, source: "error-reported", confidence: "reported" },
      })
    ).toEqual(config);
    expect(
      resolveContextCapacity({
        catalog: { contextWindow: 200_000, source: "catalog", confidence: "catalog" },
        learned: { contextWindow: 120_000, source: "error-inferred", confidence: "inferred" },
      })
    ).toMatchObject({ contextWindow: 120_000, source: "error-inferred" });
    expect(
      resolveContextCapacity({
        catalog: { contextWindow: 100_000, source: "catalog", confidence: "catalog" },
        learned: { contextWindow: 120_000, source: "error-inferred", confidence: "inferred" },
      }).contextWindow
    ).toBe(100_000);
  });

  it("subtracts shared-window reserve once and does not subtract it from a separate input limit", () => {
    const shared = deriveContextBudget(
      { contextWindow: 128_000, source: "config", confidence: "authoritative" },
      10_000,
      DEFAULT_CONTEXT_POLICY
    );
    expect(shared).toMatchObject({ hardPromptBudget: 111_616, reserveTokens: 16_384, targetTokens: 44_646 });

    const separate = deriveContextBudget(
      { maxInputTokens: 90_000, maxOutputTokens: 20_000, source: "config", confidence: "authoritative" },
      10_000,
      DEFAULT_CONTEXT_POLICY
    );
    expect(separate.hardPromptBudget).toBe(90_000);
    expect(separate.reserveTokens).toBeUndefined();
  });

  it("uses the lower combined ceiling, clamps configured reserve, and remains positive for 8k windows", () => {
    expect(
      deriveContextBudget(
        { contextWindow: 128_000, maxInputTokens: 80_000, source: "config", confidence: "authoritative" },
        1,
        DEFAULT_CONTEXT_POLICY
      ).hardPromptBudget
    ).toBe(80_000);
    expect(
      deriveContextBudget({ contextWindow: 8_000, source: "config", confidence: "authoritative" }, 1, {
        ...DEFAULT_CONTEXT_POLICY,
        reserveTokens: 50_000,
      })
    ).toMatchObject({ reserveTokens: 4_000, hardPromptBudget: 4_000 });
  });

  it("reserves a larger requested/model output requirement on shared windows", () => {
    expect(
      deriveContextBudget(
        { contextWindow: 100_000, maxOutputTokens: 30_000, source: "config", confidence: "authoritative" },
        1,
        DEFAULT_CONTEXT_POLICY
      )
    ).toMatchObject({ reserveTokens: 30_000, hardPromptBudget: 70_000 });
  });

  it("uses the smaller uncertainty margin for provider prompt snapshots", () => {
    const capacity = { contextWindow: 128_000, source: "provider", confidence: "reported" } as const;
    const estimated = deriveContextBudget(capacity, 50_000, DEFAULT_CONTEXT_POLICY);
    const provider = deriveContextBudget(capacity, 50_000, DEFAULT_CONTEXT_POLICY, { providerSnapshot: true });
    expect(provider.uncertaintyTokens).toBe(2_560);
    expect(estimated.uncertaintyTokens).toBe(6_400);
    expect(provider.compactAtTokens).toBeGreaterThan(estimated.compactAtTokens!);
  });
});
