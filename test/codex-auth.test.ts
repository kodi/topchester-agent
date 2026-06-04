import { describe, expect, it } from "vitest";
import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  CodexAuthError,
  exchangeCodexAuthorizationCode,
  extractAccountIdFromClaims,
  extractCodexAccountId,
  parseJwtClaims,
  pollCodexDeviceAuthorization,
  refreshCodexAccessToken,
  requestCodexDeviceCode,
  type CodexDeviceCode,
} from "../src/auth/codex.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createFetchQueue(responses: Response[]): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];

  return {
    requests,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const response = responses.shift();
      if (!response) {
        throw new Error(`Unexpected fetch: ${String(url)}`);
      }
      return response;
    }) as typeof fetch,
  };
}

function parseBody(init: RequestInit): Record<string, unknown> {
  const body = init.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

function parseFormBody(init: RequestInit): URLSearchParams {
  const body = init.body;
  expect(typeof body).toBe("string");
  return new URLSearchParams(body as string);
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function deviceCode(overrides: Partial<CodexDeviceCode> = {}): CodexDeviceCode {
  return {
    issuer: CODEX_ISSUER,
    verificationUrl: `${CODEX_ISSUER}/codex/device`,
    userCode: "USER-CODE",
    deviceAuthId: "device-auth-id",
    intervalSeconds: 2,
    expiresAt: 10_000,
    ...overrides,
  };
}

describe("Codex auth client", () => {
  it("requests a device code from the Codex auth server", async () => {
    const { fetch, requests } = createFetchQueue([
      createJsonResponse({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        interval: "7",
        expires_in: 900,
      }),
    ]);

    const result = await requestCodexDeviceCode({ fetch, now: () => 1000 });

    expect(result).toEqual({
      issuer: CODEX_ISSUER,
      verificationUrl: `${CODEX_ISSUER}/codex/device`,
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      intervalSeconds: 7,
      expiresAt: 901_000,
    });
    expect(requests[0]?.url).toBe(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`);
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(parseBody(requests[0]!.init)).toEqual({ client_id: CODEX_CLIENT_ID });
  });

  it("reports device-code 404 as unavailable", async () => {
    const { fetch } = createFetchQueue([createJsonResponse({ error: "missing" }, { status: 404 })]);

    await expect(requestCodexDeviceCode({ fetch })).rejects.toMatchObject({
      code: "device_login_unavailable",
    });
  });

  it("polls pending device authorization until an authorization code is returned", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const { fetch, requests } = createFetchQueue([
      createJsonResponse({ error: "pending" }, { status: 403 }),
      createJsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "code-verifier",
        code_challenge: "code-challenge",
      }),
    ]);

    const result = await pollCodexDeviceAuthorization(deviceCode(), {
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    expect(result).toEqual({
      authorizationCode: "authorization-code",
      codeVerifier: "code-verifier",
      codeChallenge: "code-challenge",
    });
    expect(sleeps).toEqual([2000]);
    expect(requests).toHaveLength(2);
    expect(parseBody(requests[0]!.init)).toEqual({
      device_auth_id: "device-auth-id",
      user_code: "USER-CODE",
    });
  });

  it("times out pending device authorization", async () => {
    let now = 0;
    const { fetch } = createFetchQueue([
      createJsonResponse({ error: "pending" }, { status: 403 }),
      createJsonResponse({ error: "pending" }, { status: 404 }),
    ]);

    await expect(
      pollCodexDeviceAuthorization(deviceCode({ intervalSeconds: 1 }), {
        fetch,
        now: () => now,
        timeoutMs: 1000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).rejects.toMatchObject({ code: "device_login_timeout" });
  });

  it("fails on unexpected polling status", async () => {
    const { fetch } = createFetchQueue([createJsonResponse({ error: "denied" }, { status: 400 })]);

    await expect(pollCodexDeviceAuthorization(deviceCode(), { fetch })).rejects.toMatchObject({
      code: "device_login_failed",
    });
  });

  it("exchanges an authorization code for a stored OAuth record", async () => {
    const idToken = jwtWithClaims({ chatgpt_account_id: "account-from-id-token" });
    const { fetch, requests } = createFetchQueue([
      createJsonResponse({
        id_token: idToken,
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 60,
      }),
    ]);

    const record = await exchangeCodexAuthorizationCode(
      {
        authorizationCode: "authorization-code",
        codeVerifier: "code-verifier",
      },
      { fetch, now: () => 1000 }
    );

    expect(record).toEqual({
      type: "oauth_codex",
      issuer: CODEX_ISSUER,
      refreshToken: "refresh-token",
      accessToken: "access-token",
      idToken,
      expiresAt: 61_000,
      accountId: "account-from-id-token",
    });
    expect(requests[0]?.url).toBe(`${CODEX_ISSUER}/oauth/token`);
    expect(requests[0]?.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(parseFormBody(requests[0]!.init))).toEqual({
      grant_type: "authorization_code",
      code: "authorization-code",
      redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: "code-verifier",
    });
  });

  it("refreshes a Codex access token and persists a rotated refresh token", async () => {
    const accessToken = jwtWithClaims({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-from-access-token",
      },
    });
    const { fetch, requests } = createFetchQueue([
      createJsonResponse({
        id_token: "invalid-id-token",
        access_token: accessToken,
        refresh_token: "rotated-refresh-token",
      }),
    ]);

    const record = await refreshCodexAccessToken("old-refresh-token", { fetch, now: () => 2000 });

    expect(record).toEqual({
      type: "oauth_codex",
      issuer: CODEX_ISSUER,
      refreshToken: "rotated-refresh-token",
      accessToken,
      idToken: "invalid-id-token",
      expiresAt: 3_602_000,
      accountId: "account-from-access-token",
    });
    expect(Object.fromEntries(parseFormBody(requests[0]!.init))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: CODEX_CLIENT_ID,
    });
  });

  it("fails token exchange when required token fields are missing", async () => {
    const { fetch } = createFetchQueue([createJsonResponse({ access_token: "access-token" })]);

    await expect(
      exchangeCodexAuthorizationCode(
        { authorizationCode: "authorization-code", codeVerifier: "code-verifier" },
        { fetch }
      )
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("extracts account ids from supported claim variants", () => {
    expect(extractAccountIdFromClaims({ chatgpt_account_id: "flat-account" })).toBe("flat-account");
    expect(
      extractAccountIdFromClaims({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "namespaced-account",
        },
      })
    ).toBe("namespaced-account");
    expect(extractAccountIdFromClaims({ organizations: [{ id: "organization-account" }] })).toBe(
      "organization-account"
    );
  });

  it("parses JWT claims and falls back from id token to access token", () => {
    const accessToken = jwtWithClaims({ organizations: [{ id: "account-from-access" }] });

    expect(parseJwtClaims(accessToken)).toEqual({ organizations: [{ id: "account-from-access" }] });
    expect(extractCodexAccountId({ id_token: "not-a-jwt", access_token: accessToken })).toBe("account-from-access");
    expect(extractCodexAccountId({ id_token: "not-a-jwt", access_token: "also-not-a-jwt" })).toBeUndefined();
  });

  it("uses typed auth errors for refresh failures", async () => {
    const { fetch } = createFetchQueue([createJsonResponse({ error: "invalid_grant" }, { status: 401 })]);

    await expect(refreshCodexAccessToken("revoked-refresh-token", { fetch })).rejects.toBeInstanceOf(CodexAuthError);
    await expect(refreshCodexAccessToken("revoked-refresh-token", { fetch })).rejects.toThrow("Unexpected fetch");
  });
});
