import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/index.js";
import { readFileTool } from "../src/agent/tools/read-file.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ModelGateway agent tool protocol", () => {
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

  it("recovers text JSON tool calls from native responses even when native protocol is forced", async () => {
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

    expect(result.toolProtocol).toBe("text-json");
    expect(result.fallbackReason).toBe("native response contained a text tool call");
    expect(result.toolCalls).toEqual([
      { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
    ]);
  });

  it("adds OpenRouter native-tool routing options internally", async () => {
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

  it("uses text JSON directly for OpenRouter auto mode when reasoning is streamed", async () => {
    let requestCount = 0;
    const reasoningEvents: string[] = [];
    const api = await startChatApi((body) => {
      requestCount += 1;
      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
      expect(body.provider).toBeUndefined();

      return {
        stream: [
          chatStreamChunk({ delta: { reasoning_content: "Using text tools." }, finish_reason: null }),
          chatStreamChunk({
            delta: { content: JSON.stringify({ tool: "read_file", args: { path: "README.md" } }) },
            finish_reason: null,
          }),
          chatStreamChunk({ delta: {}, finish_reason: "stop" }),
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
    expect(reasoningEvents).toEqual(["delta:Using text tools."]);
    expect(result.providerRejectedTools).toBe(false);
    expect(result.fallbackReason).toBe("openrouter streaming auto uses text JSON protocol");
    expect(result.protocolAttempts).toEqual([
      {
        protocol: "native-openai-compatible",
        status: "skipped",
        reason: "openrouter streaming auto uses text-json",
      },
      { protocol: "text-json", status: "used", reason: "openrouter streaming auto uses text JSON protocol" },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "text-json-0", tool: "read_file", args: { path: "README.md" }, source: "text-json" },
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
    const gateway = createGateway(api.baseURL, "openrouter");

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

function createGateway(baseURL: string, providerId: string): ModelGateway {
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });

  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  response.end("data: [DONE]\n\n");
}
