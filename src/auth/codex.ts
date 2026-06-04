import { setTimeout as sleep } from "node:timers/promises";
import type { CodexOAuthProviderRecord } from "./store.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_DEVICE_VERIFICATION_PATH = "/codex/device";
export const CODEX_DEVICE_REDIRECT_PATH = "/deviceauth/callback";
export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_BACKEND_RESPONSES_URL = `${CODEX_BACKEND_BASE_URL}/codex/responses`;
export const CODEX_DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
export const CODEX_DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;

export interface CodexFetchOptions {
  fetch?: typeof fetch;
  issuer?: string;
  now?: () => number;
}

export interface CodexDevicePollingOptions extends CodexFetchOptions {
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexDeviceCode {
  issuer: string;
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
  expiresAt: number;
}

export interface CodexDeviceAuthorization {
  authorizationCode: string;
  codeVerifier: string;
  codeChallenge?: string;
}

export interface CodexTokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export class CodexAuthError extends Error {
  readonly code:
    | "device_login_unavailable"
    | "device_login_timeout"
    | "device_login_failed"
    | "token_exchange_failed"
    | "token_refresh_failed"
    | "invalid_response";

  constructor(code: CodexAuthError["code"], message: string) {
    super(message);
    this.name = "CodexAuthError";
    this.code = code;
  }
}

export async function requestCodexDeviceCode(options: CodexFetchOptions = {}): Promise<CodexDeviceCode> {
  const issuer = normalizeIssuer(options.issuer);
  const response = await (options.fetch ?? fetch)(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });

  if (response.status === 404) {
    throw new CodexAuthError(
      "device_login_unavailable",
      "Codex device-code login is unavailable for the current auth server."
    );
  }

  if (!response.ok) {
    throw new CodexAuthError("device_login_failed", `Codex device-code request failed with status ${response.status}.`);
  }

  const body = await readJsonObject(response, "device-code response");
  const userCode = getStringProperty(body, "user_code") ?? getStringProperty(body, "usercode");
  const deviceAuthId = getStringProperty(body, "device_auth_id");
  const intervalSeconds = parsePositiveInteger(body.interval, 5);
  const expiresInSeconds = parsePositiveInteger(body.expires_in, CODEX_DEVICE_LOGIN_TIMEOUT_MS / 1000);

  if (!userCode || !deviceAuthId) {
    throw new CodexAuthError("invalid_response", "Codex device-code response is missing required fields.");
  }

  const now = options.now?.() ?? Date.now();

  return {
    issuer,
    verificationUrl: `${issuer}${CODEX_DEVICE_VERIFICATION_PATH}`,
    userCode,
    deviceAuthId,
    intervalSeconds,
    expiresAt: now + expiresInSeconds * 1000,
  };
}

export async function pollCodexDeviceAuthorization(
  deviceCode: CodexDeviceCode,
  options: CodexDevicePollingOptions = {}
): Promise<CodexDeviceAuthorization> {
  const issuer = normalizeIssuer(options.issuer ?? deviceCode.issuer);
  const fetchImpl = options.fetch ?? fetch;
  const sleepImpl = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? CODEX_DEVICE_LOGIN_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();

  while (true) {
    options.signal?.throwIfAborted();

    const response = await fetchImpl(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
      signal: options.signal,
    });

    if (response.ok) {
      const body = await readJsonObject(response, "device authorization response");
      const authorizationCode = getStringProperty(body, "authorization_code");
      const codeVerifier = getStringProperty(body, "code_verifier");
      const codeChallenge = getStringProperty(body, "code_challenge");

      if (!authorizationCode || !codeVerifier) {
        throw new CodexAuthError("invalid_response", "Codex device authorization response is missing required fields.");
      }

      return {
        authorizationCode,
        codeVerifier,
        ...(codeChallenge ? { codeChallenge } : {}),
      };
    }

    if (!isPendingDeviceAuthResponse(response)) {
      throw new CodexAuthError(
        "device_login_failed",
        `Codex device authorization failed with status ${response.status}.`
      );
    }

    if (now() - startedAt >= timeoutMs) {
      throw new CodexAuthError("device_login_timeout", "Codex device authorization timed out after 15 minutes.");
    }

    await sleepImpl(Math.max(deviceCode.intervalSeconds, 1) * 1000, options.signal);
  }
}

export async function exchangeCodexAuthorizationCode(
  authorization: CodexDeviceAuthorization,
  options: CodexFetchOptions = {}
): Promise<CodexOAuthProviderRecord> {
  const issuer = normalizeIssuer(options.issuer);
  const tokens = await requestCodexTokens(
    `${issuer}/oauth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: authorization.authorizationCode,
      redirect_uri: `${issuer}${CODEX_DEVICE_REDIRECT_PATH}`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: authorization.codeVerifier,
    }),
    "token_exchange_failed",
    options.fetch
  );

  return codexRecordFromTokenResponse(tokens, issuer, options.now?.() ?? Date.now());
}

export async function refreshCodexAccessToken(
  refreshToken: string,
  options: CodexFetchOptions = {}
): Promise<CodexOAuthProviderRecord> {
  const issuer = normalizeIssuer(options.issuer);
  const tokens = await requestCodexTokens(
    `${issuer}/oauth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
    "token_refresh_failed",
    options.fetch
  );

  return codexRecordFromTokenResponse(tokens, issuer, options.now?.() ?? Date.now());
}

export function extractCodexAccountId(tokens: Partial<CodexTokenResponse>): string | undefined {
  return extractAccountIdFromJwt(tokens.id_token) ?? extractAccountIdFromJwt(tokens.access_token);
}

export function extractAccountIdFromJwt(token: string | undefined): string | undefined {
  const claims = parseJwtClaims(token);

  if (!claims) {
    return undefined;
  }

  return extractAccountIdFromClaims(claims);
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const flatClaim = getStringProperty(claims, "chatgpt_account_id");
  if (flatClaim) {
    return flatClaim;
  }

  const authClaims = claims["https://api.openai.com/auth"];
  if (isPlainObject(authClaims)) {
    const namespacedClaim = getStringProperty(authClaims, "chatgpt_account_id");
    if (namespacedClaim) {
      return namespacedClaim;
    }
  }

  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    const firstOrganization = organizations.find(isPlainObject);
    const organizationId = firstOrganization ? getStringProperty(firstOrganization, "id") : undefined;
    if (organizationId) {
      return organizationId;
    }
  }

  return undefined;
}

export function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const parts = token?.split(".");
  if (!parts || parts.length !== 3 || !parts[1]) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function codexRecordFromTokenResponse(
  tokens: CodexTokenResponse,
  issuer: string,
  now: number
): CodexOAuthProviderRecord {
  return {
    type: "oauth_codex",
    issuer,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: now + (tokens.expires_in ?? CODEX_DEFAULT_TOKEN_EXPIRES_IN_SECONDS) * 1000,
    ...optionalAccountId(tokens),
  };
}

function optionalAccountId(tokens: CodexTokenResponse): { accountId?: string } {
  const accountId = extractCodexAccountId(tokens);
  return accountId ? { accountId } : {};
}

async function requestCodexTokens(
  url: string,
  body: URLSearchParams,
  errorCode: "token_exchange_failed" | "token_refresh_failed",
  fetchImpl = fetch
): Promise<CodexTokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const label = errorCode === "token_exchange_failed" ? "exchange" : "refresh";
    throw new CodexAuthError(errorCode, `Codex token ${label} failed with status ${response.status}.`);
  }

  const parsed = await readJsonObject(response, "token response");
  const idToken = getStringProperty(parsed, "id_token");
  const accessToken = getStringProperty(parsed, "access_token");
  const refreshToken = getStringProperty(parsed, "refresh_token");
  const expiresIn = optionalPositiveNumber(parsed.expires_in);

  if (!idToken || !accessToken || !refreshToken) {
    throw new CodexAuthError("invalid_response", "Codex token response is missing required fields.");
  }

  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
  };
}

async function readJsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new CodexAuthError("invalid_response", `Invalid Codex ${label}: ${formatErrorMessage(error)}.`);
  }

  if (!isPlainObject(parsed)) {
    throw new CodexAuthError("invalid_response", `Invalid Codex ${label}: expected an object.`);
  }

  return parsed;
}

function isPendingDeviceAuthResponse(response: Response): boolean {
  return response.status === 403 || response.status === 404;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await sleep(milliseconds, undefined, { signal });
}

function normalizeIssuer(issuer = CODEX_ISSUER): string {
  return issuer.replace(/\/+$/u, "");
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const property = value[key];
  return typeof property === "string" && property.length > 0 ? property : undefined;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
