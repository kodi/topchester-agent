import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CODEX_BACKEND_RESPONSES_URL, CODEX_ISSUER } from "../src/auth/codex.js";
import { readAuthStore, writeAuthStore } from "../src/auth/store.js";
import { ModelGateway } from "../src/model/index.js";
import { rewriteCodexRequestUrl } from "../src/model/codex.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function parseJsonBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") {
    throw new TypeError("Expected a string request body.");
  }

  return JSON.parse(init.body);
}

async function createAuthPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topchester-codex-provider-"));
  return join(root, "auth.json");
}

function createChatResponse(text = "Hello from Codex."): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: text },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function createCodexSseResponse(text = "Hello from Codex."): Response {
  const response = {
    id: "resp_test",
    created_at: 1_780_000_000,
    model: "gpt-5.5",
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  };

  return new Response(
    [
      `event: response.output_text.delta`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response })}`,
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function createGateway(
  authStorePath: string,
  fetch: typeof globalThis.fetch,
  now = 0,
  providerOverrides: Record<string, unknown> = {}
): ModelGateway {
  return new ModelGateway({
    defaultPurpose: "agent.primary",
    defaultProvider: "codex",
    models: {
      "agent.primary": { name: "gpt-5.5" },
    },
    providers: {
      codex: {
        type: "openai-compatible",
        baseURL: "https://unused.invalid/v1",
        apiKey: "stale-api-key",
        headers: {
          "Authorization": "Bearer stale-config-token",
          "X-Test": "kept",
        },
        ...providerOverrides,
      },
    },
    codexAuth: {
      authStorePath,
      fetch,
      now: () => now,
    },
  });
}

function parseFormBody(init: RequestInit): URLSearchParams {
  const body = init.body;
  expect(typeof body).toBe("string");
  return new URLSearchParams(body as string);
}

describe("Codex provider adapter", () => {
  it("rewrites OpenAI-compatible chat and responses URLs to the Codex backend", () => {
    expect(rewriteCodexRequestUrl("https://unused.invalid/v1/chat/completions")).toBe(CODEX_BACKEND_RESPONSES_URL);
    expect(rewriteCodexRequestUrl("https://unused.invalid/v1/responses?stream=true")).toBe(
      `${CODEX_BACKEND_RESPONSES_URL}?stream=true`
    );
    expect(rewriteCodexRequestUrl("https://unused.invalid/v1/models")).toBe("https://unused.invalid/v1/models");
  });

  it("injects stored Codex OAuth headers and removes stale Authorization headers", async () => {
    const authStorePath = await createAuthPath();
    const requests: CapturedRequest[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: requestUrl(url), init: init ?? {} });
      return createCodexSseResponse();
    }) as typeof globalThis.fetch;

    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: {
            type: "oauth_codex",
            issuer: CODEX_ISSUER,
            accessToken: "stored-access-token",
            refreshToken: "stored-refresh-token",
            accountId: "account-1",
            expiresAt: 60 * 60 * 1000,
          },
        },
      },
      { path: authStorePath }
    );

    const result = await createGateway(authStorePath, fetch).generateText({
      purpose: "agent.primary",
      prompt: "hello",
    });

    expect(result.text).toBe("Hello from Codex.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_BACKEND_RESPONSES_URL);
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer stored-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-1");
    expect(headers.get("X-Test")).toBe("kept");
    expect(parseJsonBody(requests[0]!.init)).toMatchObject({
      model: "gpt-5.5",
      instructions: "You are a helpful assistant.",
      stream: true,
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    expect(parseJsonBody(requests[0]!.init)).not.toHaveProperty("reasoning");
  });

  it("adds configured Codex reasoning effort to Responses requests", async () => {
    const authStorePath = await createAuthPath();
    const requests: CapturedRequest[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: requestUrl(url), init: init ?? {} });
      return createCodexSseResponse("Reasoning request worked.");
    }) as typeof globalThis.fetch;

    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: {
            type: "oauth_codex",
            issuer: CODEX_ISSUER,
            accessToken: "stored-access-token",
            refreshToken: "refresh-token",
            accountId: "account-1",
            expiresAt: 60 * 60 * 1000,
          },
        },
      },
      { path: authStorePath }
    );

    await createGateway(authStorePath, fetch, 0, { reasoningEffort: "high" }).generateText({
      purpose: "agent.primary",
      prompt: "hello",
    });

    expect(parseJsonBody(requests[0]!.init)).toMatchObject({
      reasoning: { effort: "high", summary: "auto" },
    });
  });

  it("refreshes expired Codex OAuth tokens before model requests and persists rotated tokens", async () => {
    const authStorePath = await createAuthPath();
    const requests: CapturedRequest[] = [];
    const refreshedIdToken = jwtWithClaims({ chatgpt_account_id: "account-refreshed" });
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const resolvedUrl = requestUrl(url);
      requests.push({ url: resolvedUrl, init: init ?? {} });

      if (resolvedUrl === `${CODEX_ISSUER}/oauth/token`) {
        return new Response(
          JSON.stringify({
            id_token: refreshedIdToken,
            access_token: "refreshed-access-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 120,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return createCodexSseResponse("Refreshed request worked.");
    }) as typeof globalThis.fetch;

    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: {
            type: "oauth_codex",
            issuer: CODEX_ISSUER,
            accessToken: "expired-access-token",
            refreshToken: "old-refresh-token",
            accountId: "account-old",
            expiresAt: 1000,
          },
        },
      },
      { path: authStorePath }
    );

    const result = await createGateway(authStorePath, fetch, 2000).generateText({
      purpose: "agent.primary",
      prompt: "hello",
    });

    expect(result.text).toBe("Refreshed request worked.");
    expect(requests.map((request) => request.url)).toEqual([
      `${CODEX_ISSUER}/oauth/token`,
      CODEX_BACKEND_RESPONSES_URL,
    ]);
    expect(Object.fromEntries(parseFormBody(requests[0]!.init))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    const modelHeaders = new Headers(requests[1]?.init.headers);
    expect(modelHeaders.get("Authorization")).toBe("Bearer refreshed-access-token");
    expect(modelHeaders.get("ChatGPT-Account-Id")).toBe("account-refreshed");
    await expect(readAuthStore({ path: authStorePath })).resolves.toMatchObject({
      providers: {
        codex: {
          accessToken: "refreshed-access-token",
          refreshToken: "rotated-refresh-token",
          accountId: "account-refreshed",
        },
      },
    });
  });

  it("leaves non-Codex providers on the normal OpenAI-compatible path", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: requestUrl(url), init: init ?? {} });
      return createChatResponse("Normal provider worked.");
    }) as typeof globalThis.fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;

    try {
      const gateway = new ModelGateway({
        defaultPurpose: "agent.primary",
        defaultProvider: "openrouter",
        models: {
          "agent.primary": { name: "test-model" },
        },
        providers: {
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.test/api/v1",
            apiKey: "openrouter-key",
          },
        },
      });

      await expect(gateway.generateText({ prompt: "hello" })).resolves.toMatchObject({
        text: "Normal provider worked.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests[0]?.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(new Headers(requests[0]?.init.headers).get("Authorization")).toBe("Bearer openrouter-key");
  });
});
