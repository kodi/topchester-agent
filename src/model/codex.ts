import { CODEX_BACKEND_RESPONSES_URL, refreshCodexAccessToken, type CodexFetchOptions } from "../auth/codex.js";
import {
  readAuthStore,
  setAuthProvider,
  type AuthProviderRecord,
  type CodexOAuthProviderRecord,
} from "../auth/store.js";
import { type ReasoningEffort } from "../config/index.js";
import type { OpenAICompatibleProviderConfig } from "./index.js";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

export interface CodexProviderFetchOptions extends CodexFetchOptions {
  authStorePath?: string;
  providerId?: string;
  refreshSafetyWindowMs?: number;
  reasoningEffort?: ReasoningEffort;
}

const refreshesByStoreAndProvider = new Map<string, Promise<CodexOAuthProviderRecord>>();

export function isCodexProvider(providerId: string, _config: OpenAICompatibleProviderConfig): boolean {
  return providerId === CODEX_PROVIDER_ID;
}

export function createCodexProviderFetch(options: CodexProviderFetchOptions = {}): typeof fetch {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const upstreamFetch = options.fetch ?? fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = await rewriteCodexRequest(input, init, options.reasoningEffort);
    const auth = await resolveCodexAuth({
      ...options,
      providerId,
      fetch: upstreamFetch,
    });
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("Authorization", `Bearer ${auth.accessToken}`);

    if (auth.accountId) {
      headers.set("ChatGPT-Account-Id", auth.accountId);
    }

    const response = await upstreamFetch(request.input, {
      ...request.init,
      headers,
    });

    if (request.responseMode === "chat-json") {
      return codexResponsesSseToChatJson(response);
    }

    if (request.responseMode === "chat-sse") {
      return codexResponsesSseToChatSse(response);
    }

    return response;
  }) as typeof fetch;
}

export function rewriteCodexRequestUrl(input: RequestInfo | URL): string | RequestInfo | URL {
  const url = getRequestUrl(input);

  if (!url) {
    return input;
  }

  if (url.pathname.endsWith("/v1/responses") || url.pathname.endsWith("/chat/completions")) {
    const rewritten = new URL(CODEX_BACKEND_RESPONSES_URL);
    rewritten.search = url.search;
    return rewritten.toString();
  }

  return input;
}

async function rewriteCodexRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
  reasoningEffort?: ReasoningEffort
): Promise<{
  input: string | RequestInfo | URL;
  init?: RequestInit;
  responseMode?: "chat-json" | "chat-sse";
}> {
  const rewrittenUrl = rewriteCodexRequestUrl(input);
  const body = await readJsonBody(init?.body);

  if (!isChatCompletionsBody(body)) {
    return { input: rewrittenUrl, ...(init ? { init } : {}) };
  }

  const stream = body.stream === true;
  const codexBody = chatCompletionsBodyToCodexResponsesBody(body, reasoningEffort);
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");

  return {
    input: rewrittenUrl,
    init: {
      ...init,
      headers,
      body: JSON.stringify(codexBody),
    },
    responseMode: stream ? "chat-sse" : "chat-json",
  };
}

function chatCompletionsBodyToCodexResponsesBody(
  body: ChatCompletionsBody,
  reasoningEffort?: ReasoningEffort
): Record<string, unknown> {
  const instructions = body.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => messageContentToText(message.content))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const input = body.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map(chatMessageToResponseInputItem)
    .filter((item): item is Record<string, unknown> => item !== undefined);

  return {
    model: body.model,
    instructions: instructions || "You are a helpful assistant.",
    input,
    store: false,
    stream: true,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof body.max_tokens === "number" ? { max_output_tokens: body.max_tokens } : {}),
    ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort, summary: "auto" } }),
  };
}

function chatMessageToResponseInputItem(message: ChatMessageBody): Record<string, unknown> | undefined {
  const text = messageContentToText(message.content);

  if (!text.trim()) {
    return undefined;
  }

  return {
    type: "message",
    role: message.role === "assistant" ? "assistant" : "user",
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text,
      },
    ],
  };
}

async function codexResponsesSseToChatJson(response: Response): Promise<Response> {
  if (!response.ok) {
    return response;
  }

  const parsed = parseCodexResponsesSse(await response.text());
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");

  return new Response(
    JSON.stringify({
      id: parsed.id ?? "codex-response",
      object: "chat.completion",
      created: parsed.created ?? Math.floor(Date.now() / 1000),
      model: parsed.model ?? "codex",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: parsed.text,
          },
        },
      ],
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}

async function codexResponsesSseToChatSse(response: Response): Promise<Response> {
  if (!response.ok) {
    return response;
  }

  const parsed = parseCodexResponsesSse(await response.text());
  const encoder = new TextEncoder();
  const id = parsed.id ?? "codex-response";
  const created = parsed.created ?? Math.floor(Date.now() / 1000);
  const model = parsed.model ?? "codex";
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    ...(parsed.text.match(/[\s\S]{1,2048}/gu) ?? []).map((delta) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    })),
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    },
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream");

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseCodexResponsesSse(source: string): {
  id?: string;
  created?: number;
  model?: string;
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} {
  let text = "";
  let response: Record<string, unknown> | undefined;

  for (const event of source.split(/\n\n/u)) {
    const dataLines = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      continue;
    }

    const parsed = safeJsonParse(data);
    if (!isPlainObject(parsed)) {
      continue;
    }

    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      text += parsed.delta;
    }

    if (parsed.type === "response.completed" && isPlainObject(parsed.response)) {
      response = parsed.response;
    }
  }

  return {
    ...(typeof response?.id === "string" ? { id: response.id } : {}),
    ...(typeof response?.created_at === "number" ? { created: response.created_at } : {}),
    ...(typeof response?.model === "string" ? { model: response.model } : {}),
    text,
    ...normalizeCodexUsage(response?.usage),
  };
}

function normalizeCodexUsage(usage: unknown): {
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
} {
  if (!isPlainObject(usage)) {
    return {};
  }

  const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const completionTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;

  return {
    usage: {
      ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
      ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
      ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
    },
  };
}

async function readJsonBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (typeof body !== "string") {
    return undefined;
  }

  return safeJsonParse(body);
}

function safeJsonParse(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

interface ChatCompletionsBody {
  model: string;
  messages: ChatMessageBody[];
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
}

interface ChatMessageBody {
  role: string;
  content?: unknown;
}

function isChatCompletionsBody(value: unknown): value is ChatCompletionsBody {
  return (
    isPlainObject(value) &&
    typeof value.model === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every((message) => isPlainObject(message) && typeof message.role === "string")
  );
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isPlainObject(part)) {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.content === "string") {
        return part.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveCodexAuth(
  options: CodexProviderFetchOptions = {}
): Promise<Required<Pick<CodexOAuthProviderRecord, "accessToken">> & CodexOAuthProviderRecord> {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const store = await readAuthStore({ path: options.authStorePath });
  const record = store.providers[providerId];

  if (!isCodexOAuthRecord(record)) {
    throw new Error(`Codex is not logged in. Run topchester auth login codex --device.`);
  }

  if (record.needsLogin) {
    throw new Error(`Codex auth needs a fresh login. Run topchester auth login codex --device.`);
  }

  if (hasUsableAccessToken(record, options)) {
    return record as Required<Pick<CodexOAuthProviderRecord, "accessToken">> & CodexOAuthProviderRecord;
  }

  if (!record.refreshToken) {
    throw new Error(`Codex auth is missing a refresh token. Run topchester auth login codex --device.`);
  }

  return refreshCodexAuth(providerId, record, options);
}

async function refreshCodexAuth(
  providerId: string,
  record: CodexOAuthProviderRecord,
  options: CodexProviderFetchOptions
): Promise<Required<Pick<CodexOAuthProviderRecord, "accessToken">> & CodexOAuthProviderRecord> {
  const key = `${options.authStorePath ?? "global"}:${providerId}`;
  const existing = refreshesByStoreAndProvider.get(key);
  const refreshPromise =
    existing ??
    refreshCodexAccessToken(record.refreshToken!, {
      issuer: record.issuer,
      fetch: options.fetch,
      now: options.now,
    })
      .then(async (refreshed) => {
        const merged: CodexOAuthProviderRecord = {
          ...record,
          ...refreshed,
          accountId: refreshed.accountId ?? record.accountId,
          needsLogin: false,
        };
        await setAuthProvider(providerId, merged, { path: options.authStorePath });
        return merged;
      })
      .finally(() => {
        refreshesByStoreAndProvider.delete(key);
      });

  if (!existing) {
    refreshesByStoreAndProvider.set(key, refreshPromise);
  }

  const refreshed = await refreshPromise;
  if (!refreshed.accessToken) {
    throw new Error(`Codex token refresh did not return an access token. Run topchester auth login codex --device.`);
  }

  return refreshed as Required<Pick<CodexOAuthProviderRecord, "accessToken">> & CodexOAuthProviderRecord;
}

function hasUsableAccessToken(record: CodexOAuthProviderRecord, options: CodexProviderFetchOptions): boolean {
  if (!record.accessToken) {
    return false;
  }

  if (record.expiresAt === undefined) {
    return true;
  }

  const now = options.now?.() ?? Date.now();
  const safetyWindowMs = options.refreshSafetyWindowMs ?? CODEX_REFRESH_SAFETY_WINDOW_MS;
  return record.expiresAt - safetyWindowMs > now;
}

function isCodexOAuthRecord(record: AuthProviderRecord | undefined): record is CodexOAuthProviderRecord {
  return Boolean(record && record.type === "oauth_codex");
}

function getRequestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}
