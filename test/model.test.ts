import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ModelGateway, type OpenAICompatibleProviderConfig } from "../src/model/index.js";
import { readFileTool } from "../src/agent/tools/read-file.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ModelGateway agent tool protocol", () => {
  it("suppresses the SDK system-message warning when cache markers use message input", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
    }));
    const gateway = createGateway(api.baseURL, "openrouter");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await gateway.generateText({
        purpose: "agent.primary",
        system: "system",
        prompt: "hello",
      });
    } finally {
      warn.mockRestore();
    }

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("AI SDK Warning: System messages"));
  });

  it("returns token usage from text responses", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
    }));
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });

  it("returns OpenRouter cost from text responses", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.00014 },
    }));
    const gateway = createGateway(api.baseURL, "openrouter");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.00014 });
  });

  it("returns generic top-level response cost from text responses", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
      response_cost: 0.0032,
    }));
    const gateway = createGateway(api.baseURL, "litellm");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0032 });
  });

  it("returns generic nested response cost from text responses", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, response_cost: "0.0042" },
    }));
    const gateway = createGateway(api.baseURL, "proxy");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0042 });
  });

  it("sends OpenRouter reasoning effort as nested reasoning options", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const api = await startChatApi((body) => {
      requestBody = body;
      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "openrouter", { reasoningEffort: "max" });

    const result = await gateway.generateText({ purpose: "agent.primary", prompt: "hello" });

    expect(requestBody).toMatchObject({
      reasoning: { effort: "max" },
    });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
    expect(result.reasoningEffort).toBe("max");
  });

  it("sends generic OpenAI-compatible reasoning effort as reasoning_effort", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const api = await startChatApi((body) => {
      requestBody = body;
      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "proxy", { reasoningEffort: "max" });

    const result = await gateway.generateText({ purpose: "agent.primary", prompt: "hello" });

    expect(requestBody).toMatchObject({
      reasoning_effort: "max",
    });
    expect(requestBody).not.toHaveProperty("reasoning");
    expect(result.reasoningEffort).toBe("max");
  });

  it("returns LiteLLM response cost from response headers", async () => {
    const api = await startChatApi(() => ({
      headers: { "x-litellm-response-cost": "0.0051" },
      body: {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      },
    }));
    const gateway = createGateway(api.baseURL, "litellm");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0051 });
  });

  it("sends configured service tier on text responses", async () => {
    const api = await startChatApi((body) => {
      expect(body.service_tier).toBe("flex");

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "openrouter",
      models: {
        "agent.primary": { name: "test-model" },
      },
      providers: {
        openrouter: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
          service_tier: "flex",
        },
      },
    });

    await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });
  });

  it("sends prompt cache key and message markers by default", async () => {
    const api = await startChatApi((body) => {
      expect(body.prompt_cache_key).toBe("018f0000-0000-7000-8000-000000000001");
      expect(body.messages).toEqual([
        expect.objectContaining({
          role: "system",
          content: "system",
          cache_control: { type: "ephemeral" },
        }),
        expect.objectContaining({
          role: "user",
          content: "hello",
          cache_control: { type: "ephemeral" },
        }),
      ]);

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "openrouter");

    await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
      sessionId: "018f0000-0000-7000-8000-000000000001",
    });
  });

  it("omits prompt cache fields when provider prompt caching is disabled", async () => {
    const api = await startChatApi((body) => {
      expect(body.prompt_cache_key).toBeUndefined();
      expect(
        (body.messages as Array<{ cache_control?: unknown; content?: unknown }>).some((message) => {
          if (message.cache_control) {
            return true;
          }

          return Array.isArray(message.content)
            ? message.content.some((part) => typeof part === "object" && part !== null && "cache_control" in part)
            : false;
        })
      ).toBe(false);

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hello." },
          },
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "proxy",
      models: {
        "agent.primary": { name: "test-model" },
      },
      providers: {
        proxy: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
          promptCaching: false,
        },
      },
    });

    await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
      sessionId: "018f0000-0000-7000-8000-000000000001",
    });
  });

  it("returns cache usage from provider responses", async () => {
    const api = await startChatApi(() => ({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello." },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
      },
    }));
    const gateway = createGateway(api.baseURL, "openrouter");

    const result = await gateway.generateText({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
    });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it("sends native OpenAI-compatible tools and normalizes structured tool calls", async () => {
    const api = await startChatApi((body) => {
      expect(body.tools).toEqual([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "read_file",
            description: "Read a UTF-8 file inside the workspace.",
          }),
        }),
      ]);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(false);

      return {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "package.json" }),
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read package",
      tools: [readFileTool],
    });

    expect(result.toolProtocol).toBe("native-openai-compatible");
    expect(result.protocolAttempts).toEqual([{ protocol: "native-openai-compatible", status: "used" }]);
    expect(result.toolCalls).toEqual([
      { id: "call_1", tool: "read_file", args: { path: "package.json" }, source: "native" },
    ]);
  });

  it("does not parse text JSON tool calls from accepted native responses", async () => {
    const api = await startChatApi((body) => {
      expect(body.tools).toBeDefined();

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: `${JSON.stringify({ tool: "read_file", args: { path: "README.md" } })}This text should wait.`,
            },
          },
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "fake",
      models: {
        "agent.primary": { name: "test-model", toolProtocol: "native" },
      },
      providers: {
        fake: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
        },
      },
    });

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
    });

    expect(result.toolProtocol).toBe("native-openai-compatible");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.text).toBe(
      `${JSON.stringify({ tool: "read_file", args: { path: "README.md" } })}This text should wait.`
    );
    expect(result.toolCalls).toEqual([]);
  });

  it("repairs native tool name casing through AI SDK", async () => {
    const api = await startChatApi((body) => {
      expect(body.tools).toBeDefined();

      return {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_upper",
                  type: "function",
                  function: {
                    name: "READ_FILE",
                    arguments: JSON.stringify({ path: "README.md" }),
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
    });

    expect(result.toolProtocol).toBe("native-openai-compatible");
    expect(result.toolCalls).toEqual([
      { id: "call_upper", tool: "read_file", args: { path: "README.md" }, source: "native" },
    ]);
  });

  it("keeps invalid native tool inputs out of the text fallback path", async () => {
    const api = await startChatApi((body) => {
      expect(body.tools).toBeDefined();

      return {
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_bad_args",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: 123 }),
                  },
                },
              ],
            },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
    });

    expect(result.toolProtocol).toBe("native-openai-compatible");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
  });

  it("does not add OpenRouter strict routing options by default", async () => {
    const api = await startChatApi((body) => {
      expect(body.provider).toBeUndefined();
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.service_tier).toBe("flex");

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "openrouter",
      models: {
        "agent.primary": { name: "test-model", toolProtocol: "native" },
      },
      providers: {
        openrouter: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
          service_tier: "flex",
        },
      },
    });

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
      tools: [readFileTool],
    });

    expect(result.openRouterRoutingApplied).toBe(false);
  });

  it("adds OpenRouter strict routing options when forced", async () => {
    const api = await startChatApi((body) => {
      expect(body.provider).toEqual({ require_parameters: true });
      expect(body.parallel_tool_calls).toBe(false);

      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "openrouter",
      models: {
        "agent.primary": { name: "test-model", toolProtocol: "native" },
      },
      providers: {
        openrouter: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
          openRouterToolRouting: "force",
        },
      },
    });

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "hello",
      tools: [readFileTool],
    });

    expect(result.openRouterRoutingApplied).toBe(true);
  });

  it("falls back to text JSON when the provider rejects native tools", async () => {
    let requestCount = 0;
    const api = await startChatApi((body) => {
      requestCount += 1;

      if (requestCount === 1) {
        expect(body.tools).toBeDefined();
        return { status: 400, body: { error: { message: "tools are not supported by this model" } } };
      }

      expect(body.tools).toBeUndefined();
      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({ tool: "read_file", args: { path: "README.md" } }),
            },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
    });

    expect(result.providerRejectedTools).toBe(true);
    expect(result.fallbackReason).toBe("provider rejected native tools");
    expect(result.protocolAttempts.map((attempt) => attempt.protocol)).toEqual([
      "native-openai-compatible",
      "text-json",
    ]);
    expect(result.toolCalls).toEqual([
      { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
    ]);
  });

  it("streams provider reasoning deltas while preserving native tool results", async () => {
    const reasoningEvents: string[] = [];
    const api = await startChatApi((body) => {
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.tools).toBeDefined();

      return {
        stream: [
          chatStreamChunk({ delta: { reasoning_content: "Inspecting " }, finish_reason: null }),
          chatStreamChunk({ delta: { reasoning_content: "files" }, finish_reason: null }),
          chatStreamChunk({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) },
                },
              ],
            },
            finish_reason: null,
          }),
          chatStreamChunk({
            delta: {},
            finish_reason: "tool_calls",
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.00042 },
          }),
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "openrouter",
      models: {
        "agent.primary": { name: "test-model", toolProtocol: "native" },
      },
      providers: {
        openrouter: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
        },
      },
    });

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read package",
      tools: [readFileTool],
      onReasoning(event) {
        reasoningEvents.push(`${event.type}:${event.text}`);
      },
    });

    expect(reasoningEvents).toEqual(["delta:Inspecting ", "delta:files"]);
    expect(result.toolProtocol).toBe("native-openai-compatible");
    expect(result.toolCalls).toEqual([
      { id: "call_1", tool: "read_file", args: { path: "package.json" }, source: "native" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.00042 });
  });

  it("can omit streaming usage options for strict proxies", async () => {
    const api = await startChatApi((body) => {
      expect(body.stream).toBe(true);
      expect(body.stream_options).toBeUndefined();

      return {
        stream: [
          chatStreamChunk({ delta: { content: "Hello." }, finish_reason: null }),
          chatStreamChunk({ delta: {}, finish_reason: "stop" }),
        ],
      };
    });
    const gateway = new ModelGateway({
      defaultPurpose: "agent.primary",
      defaultProvider: "proxy",
      models: {
        "agent.primary": { name: "test-model" },
      },
      providers: {
        proxy: {
          type: "openai-compatible",
          baseURL: api.baseURL,
          apiKey: "test",
          includeUsage: false,
        },
      },
    });

    const chunks: string[] = [];
    for await (const chunk of gateway.streamText({ purpose: "agent.primary", prompt: "hello" })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Hello.");
  });

  it("uses native tools for OpenRouter auto mode when reasoning is streamed", async () => {
    let requestCount = 0;
    const reasoningEvents: string[] = [];
    const api = await startChatApi((body) => {
      requestCount += 1;
      expect(body.stream).toBe(true);
      expect(body.tools).toBeDefined();
      expect(body.provider).toBeUndefined();

      return {
        stream: [
          chatStreamChunk({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
                },
              ],
            },
            finish_reason: null,
          }),
          chatStreamChunk({ delta: {}, finish_reason: "tool_calls" }),
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "openrouter");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
      onReasoning(event) {
        reasoningEvents.push(`${event.type}:${event.text}`);
      },
    });

    expect(requestCount).toBe(1);
    expect(reasoningEvents).toEqual([]);
    expect(result.providerRejectedTools).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.protocolAttempts).toEqual([{ protocol: "native-openai-compatible", status: "used" }]);
    expect(result.toolCalls).toEqual([
      { id: "call_read", tool: "read_file", args: { path: "README.md" }, source: "native" },
    ]);
  });

  it("streams reasoning from text fallback when native tools are rejected", async () => {
    let requestCount = 0;
    const reasoningEvents: string[] = [];
    const api = await startChatApi((body) => {
      requestCount += 1;

      if (requestCount === 1) {
        expect(body.stream).toBe(true);
        expect(body.tools).toBeDefined();
        return { status: 400, body: { error: { message: "tools are not supported by this model" } } };
      }

      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
      return {
        stream: [
          chatStreamChunk({ delta: { reasoning_content: "Switching protocols." }, finish_reason: null }),
          chatStreamChunk({
            delta: { content: JSON.stringify({ tool: "read_file", args: { path: "README.md" } }) },
            finish_reason: null,
          }),
          chatStreamChunk({ delta: {}, finish_reason: "stop" }),
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "fake");

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
      onReasoning(event) {
        reasoningEvents.push(`${event.type}:${event.text}`);
      },
    });

    expect(requestCount).toBe(2);
    expect(reasoningEvents).toEqual(["delta:Switching protocols."]);
    expect(result.providerRejectedTools).toBe(true);
    expect(result.fallbackReason).toBe("provider rejected native tools");
    expect(result.protocolAttempts.map((attempt) => attempt.protocol)).toEqual([
      "native-openai-compatible",
      "text-json",
    ]);
    expect(result.toolCalls).toEqual([
      { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
    ]);
  });

  it("settles rejected native stream promises before falling back to text JSON", async () => {
    let requestCount = 0;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const api = await startChatApi((body) => {
        requestCount += 1;

        if (requestCount === 1) {
          expect(body.stream).toBe(true);
          expect(body.tools).toBeDefined();
          return {
            status: 400,
            body: {
              error: {
                message:
                  "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
              },
            },
          };
        }

        expect(body.stream).toBe(true);
        expect(body.tools).toBeUndefined();
        return {
          stream: [
            chatStreamChunk({
              delta: { content: JSON.stringify({ tool: "read_file", args: { path: "README.md" } }) },
              finish_reason: null,
            }),
            chatStreamChunk({ delta: {}, finish_reason: "stop" }),
          ],
        };
      });
      const gateway = createGateway(api.baseURL, "fake");

      const result = await gateway.generateAgentStep({
        purpose: "agent.primary",
        system: "system",
        prompt: "read readme",
        tools: [readFileTool],
        onReasoning() {},
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(requestCount).toBe(2);
      expect(unhandledRejections).toEqual([]);
      expect(result.providerRejectedTools).toBe(true);
      expect(result.fallbackReason).toBe("provider rejected native tools");
      expect(result.protocolAttempts.map((attempt) => attempt.protocol)).toEqual([
        "native-openai-compatible",
        "text-json",
      ]);
      expect(result.toolCalls).toEqual([
        { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("falls back to text JSON when OpenRouter rejects requested native parameters", async () => {
    let requestCount = 0;
    const api = await startChatApi((body) => {
      requestCount += 1;

      if (requestCount === 1) {
        expect(body.tools).toBeDefined();
        expect(body.provider).toEqual({ require_parameters: true });
        return {
          status: 400,
          body: {
            error: {
              message:
                "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
            },
          },
        };
      }

      expect(body.tools).toBeUndefined();
      expect(body.provider).toBeUndefined();
      return {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({ tool: "read_file", args: { path: "README.md" } }),
            },
          },
        ],
      };
    });
    const gateway = createGateway(api.baseURL, "openrouter", { openRouterToolRouting: "force" });

    const result = await gateway.generateAgentStep({
      purpose: "agent.primary",
      system: "system",
      prompt: "read readme",
      tools: [readFileTool],
    });

    expect(result.providerRejectedTools).toBe(true);
    expect(result.toolProtocol).toBe("text-json");
    expect(result.protocolAttempts).toEqual([
      expect.objectContaining({
        protocol: "native-openai-compatible",
        status: "failed",
        reason: expect.stringContaining("requested parameters"),
      }),
      { protocol: "text-json", status: "used", reason: "provider rejected native tools" },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
    ]);
  });
});

function createGateway(
  baseURL: string,
  providerId: string,
  providerOverrides: Partial<OpenAICompatibleProviderConfig> = {}
): ModelGateway {
  return new ModelGateway({
    defaultPurpose: "agent.primary",
    defaultProvider: providerId,
    models: {
      "agent.primary": { name: "test-model" },
    },
    providers: {
      [providerId]: {
        type: "openai-compatible",
        baseURL,
        apiKey: "test",
        ...providerOverrides,
      },
    },
  });
}

async function startChatApi(
  handler: (body: Record<string, unknown>) =>
    | Record<string, unknown>
    | {
        status: number;
        body: Record<string, unknown>;
      }
    | {
        stream: Record<string, unknown>[];
      }
    | {
        headers: Record<string, string>;
        body: Record<string, unknown>;
      }
): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const body = (await readJson(request)) as Record<string, unknown>;
    const result = handler(body);

    if (isErrorResult(result)) {
      writeJson(response, result.status, result.body);
      return;
    }

    if (isStreamResult(result)) {
      writeSse(response, result.stream);
      return;
    }

    if (isResponseWithHeaders(result)) {
      writeJson(
        response,
        200,
        {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          ...result.body,
        },
        result.headers
      );
      return;
    }

    writeJson(response, 200, {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      ...result,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test API did not bind.");
  }

  const handle = {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
  servers.push(handle);

  return handle;
}

function chatStreamChunk(options: {
  delta: Record<string, unknown>;
  finish_reason: string | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [{ index: 0, delta: options.delta, finish_reason: options.finish_reason }],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

function isErrorResult(value: unknown): value is { status: number; body: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    typeof (value as { body?: unknown }).body === "object" &&
    (value as { body?: unknown }).body !== null
  );
}

function isStreamResult(value: unknown): value is { stream: Record<string, unknown>[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { stream?: unknown }).stream);
}

function isResponseWithHeaders(
  value: unknown
): value is { headers: Record<string, string>; body: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { headers?: unknown }).headers === "object" &&
    (value as { headers?: unknown }).headers !== null &&
    typeof (value as { body?: unknown }).body === "object" &&
    (value as { body?: unknown }).body !== null
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });

  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  response.end("data: [DONE]\n\n");
}
