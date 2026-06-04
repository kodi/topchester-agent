import { CODEX_BACKEND_RESPONSES_URL, refreshCodexAccessToken, type CodexFetchOptions } from "../auth/codex.js";
import {
  readAuthStore,
  setAuthProvider,
  type AuthProviderRecord,
  type CodexOAuthProviderRecord,
} from "../auth/store.js";
import type { OpenAICompatibleProviderConfig } from "./index.js";

export const CODEX_PROVIDER_ID = "codex";
export const CODEX_REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

export interface CodexProviderFetchOptions extends CodexFetchOptions {
  authStorePath?: string;
  providerId?: string;
  refreshSafetyWindowMs?: number;
}

const refreshesByStoreAndProvider = new Map<string, Promise<CodexOAuthProviderRecord>>();

export function isCodexProvider(providerId: string, _config: OpenAICompatibleProviderConfig): boolean {
  return providerId === CODEX_PROVIDER_ID;
}

export function createCodexProviderFetch(options: CodexProviderFetchOptions = {}): typeof fetch {
  const providerId = options.providerId ?? CODEX_PROVIDER_ID;
  const upstreamFetch = options.fetch ?? fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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

    return upstreamFetch(rewriteCodexRequestUrl(input), {
      ...init,
      headers,
    });
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
