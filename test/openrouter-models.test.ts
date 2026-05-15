import { describe, expect, it } from "vitest";
import {
  fallbackOpenRouterStarterChoices,
  fetchOpenRouterModelChoices,
  rankOpenRouterModelChoices,
  selectOpenRouterStarterChoices,
} from "../src/model/openrouter.js";

describe("OpenRouter model catalog", () => {
  it("maps OpenRouter model ids to Topchester model refs", async () => {
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toContain("https://openrouter.ai/api/v1/models?");
      expect(String(url)).toContain("output_modalities=text");
      expect(String(url)).toContain("supported_parameters=tools");
      expect(init?.headers).toEqual({});

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/qwen3-coder",
              name: "Qwen3 Coder",
              context_length: 262144,
              supported_parameters: ["tools"],
              architecture: { output_modalities: ["text"] },
              pricing: { prompt: "0.0000002", completion: "0.0000008" },
            },
          ],
        })
      );
    };

    await expect(fetchOpenRouterModelChoices({ fetchImpl })).resolves.toEqual([
      {
        ref: "openrouter/qwen/qwen3-coder",
        id: "qwen/qwen3-coder",
        label: "Qwen3 Coder",
        description: "262k ctx · $0.20/$0.80 per 1M",
      },
    ]);
  });

  it("uses user-filtered OpenRouter models when an API key is present", async () => {
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toContain("https://openrouter.ai/api/v1/models/user?");
      expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });

      return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-4.5" }] }));
    };

    await expect(fetchOpenRouterModelChoices({ apiKey: "test-key", userFiltered: true, fetchImpl })).resolves.toEqual([
      {
        ref: "openrouter/anthropic/claude-sonnet-4.5",
        id: "anthropic/claude-sonnet-4.5",
        label: "anthropic/claude-sonnet-4.5",
        description: "ctx ?",
      },
    ]);
  });

  it("selects a small coding-oriented starter shortlist", () => {
    const catalog = [
      {
        ref: "openrouter/anthropic/claude-opus-4.7-fast",
        id: "anthropic/claude-opus-4.7-fast",
        label: "Opus",
        description: "",
      },
      {
        ref: "openrouter/perceptron/perceptron-mk1",
        id: "perceptron/perceptron-mk1",
        label: "Perceptron",
        description: "",
      },
      { ref: "openrouter/google/gemini-flash", id: "google/gemini-flash", label: "Gemini", description: "" },
      {
        ref: "openrouter/google/gemini-3.1-flash-lite",
        id: "google/gemini-3.1-flash-lite",
        label: "Gemini Flash Lite",
        description: "",
      },
      { ref: "openrouter/qwen/qwen3-coder", id: "qwen/qwen3-coder", label: "Qwen", description: "" },
      {
        ref: "openrouter/qwen/qwen3-coder:free",
        id: "qwen/qwen3-coder:free",
        label: "Qwen Free",
        description: "",
      },
      {
        ref: "openrouter/openai/gpt-5-codex",
        id: "openai/gpt-5-codex",
        label: "GPT-5 Codex",
        description: "",
      },
      {
        ref: "openrouter/x-ai/grok-4.3",
        id: "x-ai/grok-4.3",
        label: "Grok",
        description: "",
      },
      {
        ref: "openrouter/mistralai/mistral-medium-3-5",
        id: "mistralai/mistral-medium-3-5",
        label: "Mistral Medium",
        description: "",
      },
      {
        ref: "openrouter/deepseek/deepseek-chat",
        id: "deepseek/deepseek-chat",
        label: "DeepSeek Chat",
        description: "",
      },
      {
        ref: "openrouter/inclusionai/ring-2.6-1t",
        id: "inclusionai/ring-2.6-1t",
        label: "Ring",
        description: "",
      },
      {
        ref: "openrouter/openrouter/owl-alpha",
        id: "openrouter/owl-alpha",
        label: "Owl",
        description: "",
      },
      {
        ref: "openrouter/anthropic/claude-sonnet-4.5",
        id: "anthropic/claude-sonnet-4.5",
        label: "Sonnet",
        description: "",
      },
    ];

    expect(selectOpenRouterStarterChoices(catalog)).toEqual([
      "openrouter/qwen/qwen3-coder:free",
      "openrouter/qwen/qwen3-coder",
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/openai/gpt-5-codex",
      "openrouter/google/gemini-3.1-flash-lite",
      "openrouter/x-ai/grok-4.3",
      "openrouter/mistralai/mistral-medium-3-5",
      "openrouter/deepseek/deepseek-chat",
      "openrouter/inclusionai/ring-2.6-1t",
      "openrouter/openrouter/owl-alpha",
    ]);
    expect(
      rankOpenRouterModelChoices(catalog)
        .map((choice) => choice.ref)
        .filter((ref) => !ref.startsWith("openrouter/qwen/"))
        .slice(0, 2)
    ).toEqual(["openrouter/anthropic/claude-sonnet-4.5", "openrouter/openai/gpt-5-codex"]);
    expect(fallbackOpenRouterStarterChoices()).toEqual([
      "openrouter/qwen/qwen3-coder:free",
      "openrouter/qwen/qwen3-coder",
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/openai/gpt-5-codex",
      "openrouter/google/gemini-3.1-flash-lite",
      "openrouter/x-ai/grok-4.3",
      "openrouter/mistralai/mistral-medium-3-5",
      "openrouter/deepseek/deepseek-chat",
      "openrouter/inclusionai/ring-2.6-1t",
      "openrouter/openrouter/owl-alpha",
    ]);
  });
});
