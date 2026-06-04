import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuthStoreError,
  createEmptyAuthStore,
  getAuthStoreStatus,
  readAuthStore,
  removeAuthProvider,
  setAuthProvider,
  writeAuthStore,
  type AuthStore,
} from "../src/auth/store.js";

async function createAuthPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topchester-auth-store-"));
  return join(root, "config", "topchester", "auth.json");
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

describe("auth store", () => {
  it("returns an empty store when the auth file is missing", async () => {
    const path = await createAuthPath();

    await expect(readAuthStore({ path })).resolves.toEqual(createEmptyAuthStore());
    await expect(getAuthStoreStatus({ path })).resolves.toEqual({
      path,
      exists: false,
      providers: [],
    });
  });

  it("writes the auth directory and file with private modes where supported", async () => {
    const path = await createAuthPath();
    const store: AuthStore = {
      version: 1,
      providers: {
        codex: {
          type: "oauth_codex",
          issuer: "https://auth.openai.com",
          refreshToken: "refresh-secret",
          accessToken: "access-secret",
          idToken: "id-secret",
          expiresAt: 1_790_000_000_000,
          accountId: "account-1",
        },
      },
    };

    await writeAuthStore(store, { path });

    expect(await readAuthStore({ path })).toEqual(store);
    expect(modeBits((await stat(join(path, ".."))).mode)).toBe(0o700);
    expect(modeBits((await stat(path)).mode)).toBe(0o600);
  });

  it("preserves unknown provider records when updating one provider", async () => {
    const path = await createAuthPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        providers: {
          future: {
            type: "oauth_future",
            nested: { value: true },
          },
        },
      })
    );

    await setAuthProvider(
      "codex",
      {
        type: "oauth_codex",
        refreshToken: "refresh-secret",
      },
      { path }
    );

    expect(await readAuthStore({ path })).toEqual({
      version: 1,
      providers: {
        future: {
          type: "oauth_future",
          nested: { value: true },
        },
        codex: {
          type: "oauth_codex",
          refreshToken: "refresh-secret",
        },
      },
    });
  });

  it("removes only the requested provider", async () => {
    const path = await createAuthPath();
    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: { type: "oauth_codex", refreshToken: "refresh-secret" },
          future: { type: "oauth_future", token: "future-secret" },
        },
      },
      { path }
    );

    await removeAuthProvider("codex", { path });

    expect(await readAuthStore({ path })).toEqual({
      version: 1,
      providers: {
        future: { type: "oauth_future", token: "future-secret" },
      },
    });
  });

  it("rejects corrupted or invalid auth stores without overwriting them", async () => {
    const path = await createAuthPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ nope");

    await expect(readAuthStore({ path })).rejects.toBeInstanceOf(AuthStoreError);
    await expect(setAuthProvider("codex", { type: "oauth_codex" }, { path })).rejects.toBeInstanceOf(AuthStoreError);
    expect(await readFile(path, "utf8")).toBe("{ nope");
  });

  it("reports corrupt status without throwing", async () => {
    const path = await createAuthPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, '{"version":2,"providers":{}}');

    const status = await getAuthStoreStatus({ path });

    expect(status).toMatchObject({
      path,
      exists: true,
      providers: [],
    });
    expect(status.error).toContain("Invalid Topchester auth store");
  });

  it("redacts token values in status output", async () => {
    const path = await createAuthPath();
    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: {
            type: "oauth_codex",
            refreshToken: "refresh-secret",
            accessToken: "access-secret",
            idToken: "id-secret",
            accountId: "account-secret",
            expiresAt: 1000,
            needsLogin: true,
          },
        },
      },
      { path }
    );

    const status = await getAuthStoreStatus({ path, now: () => 2000 });

    expect(status.providers).toEqual([
      {
        id: "codex",
        type: "oauth_codex",
        source: "stored",
        hasRefreshToken: true,
        hasAccessToken: true,
        hasIdToken: true,
        hasAccountId: true,
        expiresAt: 1000,
        needsRefresh: true,
        needsLogin: true,
      },
    ]);
    expect(JSON.stringify(status)).not.toContain("secret");
  });
});
