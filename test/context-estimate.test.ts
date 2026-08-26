import { describe, expect, it } from "vite-plus/test";
import {
  estimateProviderRequest,
  fingerprintProviderRequest,
  reconcilePromptUsage,
} from "../src/agent/context/estimate.js";

const route = { providerId: "proxy", baseURL: "https://proxy.test/v1", modelId: "model" };

describe("active prompt estimation", () => {
  it("covers system, prompt, tools, images, and provider options", () => {
    const base = estimateProviderRequest({ route, system: "system", prompt: "hello" });
    const complete = estimateProviderRequest({
      route,
      system: "system",
      prompt: "hello",
      toolDefinitions: [{ name: "read_file", schema: { path: "string" } }],
      images: [{ bytes: 4096, detail: "high" }],
      providerOptions: { serviceTier: "priority" },
    });
    expect(complete.tokens).toBeGreaterThan(base.tokens);
    expect(complete.fingerprint).not.toBe(base.fingerprint);
  });

  it("invalidates fingerprints for route, system, prompt, tools, images, and options", () => {
    const input = { route, system: "s", prompt: "p", toolDefinitions: [{ name: "x" }] };
    const fingerprint = fingerprintProviderRequest(input);
    for (const changed of [
      { ...input, route: { ...route, baseURL: "https://other.test/v1" } },
      { ...input, system: "changed" },
      { ...input, prompt: "changed" },
      { ...input, toolDefinitions: [{ name: "y" }] },
      { ...input, images: [{ bytes: 1 }] },
      { ...input, providerOptions: { mode: "changed" } },
    ]) {
      expect(fingerprintProviderRequest(changed)).not.toBe(fingerprint);
    }
  });

  it("treats provider input usage as the active snapshot without adding cache tokens", () => {
    const request = { route, system: "system", prompt: "prompt" };
    const usage = reconcilePromptUsage({ request, providerPromptTokens: 12_345, modelCall: 2 });
    expect(usage).toMatchObject({
      promptTokens: 12_345,
      trailingEstimatedTokens: 0,
      source: "provider",
      estimated: false,
    });
  });

  it("uses a complete estimate when the provider snapshot fingerprint is stale", () => {
    const request = { route, system: "system", prompt: "prompt" };
    const prior = reconcilePromptUsage({ request, providerPromptTokens: 100, modelCall: 1 });
    const next = reconcilePromptUsage({
      request: { ...request, system: "changed" },
      prior,
      trailingText: "tail",
      modelCall: 2,
    });
    expect(next.source).toBe("local-estimate");
    expect(next.estimated).toBe(true);
  });

  it("adds only trailing retained content when the provider request base still matches", () => {
    const request = { route, system: "system", prompt: "provider-bound base" };
    const prior = reconcilePromptUsage({ request, providerPromptTokens: 100, modelCall: 1 });
    const next = reconcilePromptUsage({ request, prior, trailingText: "new settled tool result", modelCall: 2 });
    expect(next).toMatchObject({
      promptTokens: 100,
      source: "provider",
      estimated: true,
      trailingEstimatedTokens: expect.any(Number),
    });
    expect(next.trailingEstimatedTokens).toBeGreaterThan(0);
  });
});
