import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getProviderModelCapacity,
  parseProviderModelCapacity,
  recordProviderModelCapacity,
} from "../src/agent/context/provider-metadata.js";
import { ModelGateway } from "../src/model/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider model capacity discovery", () => {
  it("accepts only consistent allowlisted capacity fields", () => {
    expect(
      parseProviderModelCapacity({
        context_length: 128_000,
        context_window: 128_000,
        max_input_tokens: 100_000,
        max_output_tokens: 28_000,
        unrelated_limit: 999_999,
      })
    ).toMatchObject({ contextWindow: 128_000, maxInputTokens: 100_000, maxOutputTokens: 28_000 });
    expect(parseProviderModelCapacity({ context_length: 128_000, context_window: 64_000 })).toBeUndefined();
  });

  it("expires retained provider metadata for the exact route", () => {
    const route = { providerId: "proxy", baseURL: "https://ttl.test/v1", modelId: "fixture-model" };
    recordProviderModelCapacity(route, {
      contextWindow: 96_000,
      source: "provider",
      confidence: "reported",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(getProviderModelCapacity(route, Date.parse("2026-02-01T00:00:00.001Z"))).toBeUndefined();
  });

  it("does not probe a generic provider unless discovery is explicitly enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createGateway("https://no-probe.test/v1", false);

    await expect(gateway.discoverModelCapacity()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the exact model entry from an opted-in VibeProxy-like models response", async () => {
    const fetchMock = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: [
              { id: "other-model", context_length: 256_000 },
              { id: "fixture-model", context_window: 96_000, max_input_tokens: 80_000 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createGateway("https://vibeproxy-like.test/v1", true);

    await expect(gateway.discoverModelCapacity()).resolves.toMatchObject({
      route: {
        providerId: "proxy",
        baseURL: "https://vibeproxy-like.test/v1",
        modelId: "fixture-model",
      },
      capacity: { contextWindow: 96_000, maxInputTokens: 80_000, source: "provider" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requested = fetchMock.mock.calls[0]?.[0];
    const requestedURL =
      requested instanceof URL ? requested.href : typeof requested === "string" ? requested : requested?.url;
    expect(requestedURL).toBe("https://vibeproxy-like.test/v1/models");
  });
});

function createGateway(baseURL: string, discoverModelLimits: boolean): ModelGateway {
  return new ModelGateway({
    defaultPurpose: "agent.primary",
    defaultProvider: "proxy",
    models: { "agent.primary": { provider: "proxy", name: "fixture-model" } },
    providers: {
      proxy: {
        type: "openai-compatible",
        baseURL,
        apiKey: "fixture-key",
        discoverModelLimits,
      },
    },
  });
}
