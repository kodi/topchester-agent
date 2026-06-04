import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOPCHESTER_AUTH_STORE_VERSION = 1;
export const TOPCHESTER_AUTH_FILE_NAME = "auth.json";

export interface CodexOAuthProviderRecord {
  type: "oauth_codex";
  issuer?: string;
  refreshToken?: string;
  accessToken?: string;
  idToken?: string;
  expiresAt?: number;
  accountId?: string;
  needsLogin?: boolean;
}

export type AuthProviderRecord = CodexOAuthProviderRecord | Record<string, unknown>;

export interface AuthStore {
  version: typeof TOPCHESTER_AUTH_STORE_VERSION;
  providers: Record<string, AuthProviderRecord>;
}

export interface AuthStoreOptions {
  path?: string;
  now?: () => number;
}

export interface AuthProviderStatus {
  id: string;
  type: string;
  source: "stored";
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  hasIdToken: boolean;
  hasAccountId: boolean;
  expiresAt?: number;
  needsRefresh: boolean;
  needsLogin: boolean;
}

export interface AuthStoreStatus {
  path: string;
  exists: boolean;
  providers: AuthProviderStatus[];
  error?: string;
}

export class AuthStoreError extends Error {
  readonly code: "invalid_auth_store";
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid Topchester auth store at ${path}: ${message}`);
    this.name = "AuthStoreError";
    this.code = "invalid_auth_store";
    this.path = path;
  }
}

export function getGlobalTopchesterAuthDir(): string {
  return join(process.env.HOME ?? homedir(), ".config", "topchester");
}

export function getGlobalTopchesterAuthPath(): string {
  return join(getGlobalTopchesterAuthDir(), TOPCHESTER_AUTH_FILE_NAME);
}

export function createEmptyAuthStore(): AuthStore {
  return {
    version: TOPCHESTER_AUTH_STORE_VERSION,
    providers: {},
  };
}

export async function readAuthStore(options: AuthStoreOptions = {}): Promise<AuthStore> {
  const path = options.path ?? getGlobalTopchesterAuthPath();

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createEmptyAuthStore();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AuthStoreError(path, formatErrorMessage(error));
  }

  return parseAuthStore(path, parsed);
}

export async function writeAuthStore(store: AuthStore, options: AuthStoreOptions = {}): Promise<void> {
  const path = options.path ?? getGlobalTopchesterAuthPath();
  const parsed = parseAuthStore(path, store);
  const dir = dirname(path);
  const temporaryPath = join(dir, `.${TOPCHESTER_AUTH_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await setModeIfSupported(dir, 0o700);

  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await setModeIfSupported(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await setModeIfSupported(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function setAuthProvider(
  providerId: string,
  record: AuthProviderRecord,
  options: AuthStoreOptions = {}
): Promise<AuthStore> {
  const store = await readAuthStore(options);
  const updated = {
    ...store,
    providers: {
      ...store.providers,
      [providerId]: record,
    },
  };

  await writeAuthStore(updated, options);
  return updated;
}

export async function removeAuthProvider(providerId: string, options: AuthStoreOptions = {}): Promise<AuthStore> {
  const store = await readAuthStore(options);
  const providers = { ...store.providers };
  delete providers[providerId];
  const updated = { ...store, providers };

  await writeAuthStore(updated, options);
  return updated;
}

export async function getAuthStoreStatus(options: AuthStoreOptions = {}): Promise<AuthStoreStatus> {
  const path = options.path ?? getGlobalTopchesterAuthPath();

  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        path,
        exists: false,
        providers: [],
      };
    }
    throw error;
  }

  try {
    const store = await readAuthStore({ ...options, path });
    return {
      path,
      exists: true,
      providers: Object.entries(store.providers)
        .map(([id, record]) => redactProviderStatus(id, record, options.now?.() ?? Date.now()))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  } catch (error) {
    if (error instanceof AuthStoreError) {
      return {
        path,
        exists: true,
        providers: [],
        error: error.message,
      };
    }
    throw error;
  }
}

function parseAuthStore(path: string, value: unknown): AuthStore {
  if (!isPlainObject(value)) {
    throw new AuthStoreError(path, "<root>: expected an object");
  }

  if (value.version !== TOPCHESTER_AUTH_STORE_VERSION) {
    throw new AuthStoreError(path, "version: expected 1");
  }

  if (!isPlainObject(value.providers)) {
    throw new AuthStoreError(path, "providers: expected an object");
  }

  const providers: Record<string, AuthProviderRecord> = {};
  for (const [providerId, providerRecord] of Object.entries(value.providers)) {
    if (!providerId) {
      throw new AuthStoreError(path, "providers: provider id must not be empty");
    }
    if (!isPlainObject(providerRecord)) {
      throw new AuthStoreError(path, `providers.${providerId}: expected an object`);
    }

    providers[providerId] = parseProviderRecord(path, providerId, providerRecord);
  }

  return {
    version: TOPCHESTER_AUTH_STORE_VERSION,
    providers,
  };
}

function parseProviderRecord(path: string, providerId: string, value: Record<string, unknown>): AuthProviderRecord {
  if (value.type === "oauth_codex") {
    return {
      type: "oauth_codex",
      ...optionalStringProperty(value, "issuer", path, providerId),
      ...optionalStringProperty(value, "refreshToken", path, providerId),
      ...optionalStringProperty(value, "accessToken", path, providerId),
      ...optionalStringProperty(value, "idToken", path, providerId),
      ...optionalNumberProperty(value, "expiresAt", path, providerId),
      ...optionalStringProperty(value, "accountId", path, providerId),
      ...optionalBooleanProperty(value, "needsLogin", path, providerId),
    };
  }

  return { ...value };
}

function optionalStringProperty(
  value: Record<string, unknown>,
  key: string,
  path: string,
  providerId: string
): Partial<Record<typeof key, string>> {
  const property = value[key];
  if (property === undefined) {
    return {};
  }
  if (typeof property !== "string") {
    throw new AuthStoreError(path, `providers.${providerId}.${key}: expected a string`);
  }
  return { [key]: property };
}

function optionalNumberProperty(
  value: Record<string, unknown>,
  key: string,
  path: string,
  providerId: string
): Partial<Record<typeof key, number>> {
  const property = value[key];
  if (property === undefined) {
    return {};
  }
  if (typeof property !== "number" || !Number.isFinite(property)) {
    throw new AuthStoreError(path, `providers.${providerId}.${key}: expected a finite number`);
  }
  return { [key]: property };
}

function optionalBooleanProperty(
  value: Record<string, unknown>,
  key: string,
  path: string,
  providerId: string
): Partial<Record<typeof key, boolean>> {
  const property = value[key];
  if (property === undefined) {
    return {};
  }
  if (typeof property !== "boolean") {
    throw new AuthStoreError(path, `providers.${providerId}.${key}: expected a boolean`);
  }
  return { [key]: property };
}

function redactProviderStatus(id: string, record: AuthProviderRecord, now: number): AuthProviderStatus {
  const type = typeof record.type === "string" ? record.type : "unknown";
  const expiresAt =
    typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt : undefined;

  return {
    id,
    type,
    source: "stored",
    hasRefreshToken: typeof record.refreshToken === "string" && record.refreshToken.length > 0,
    hasAccessToken: typeof record.accessToken === "string" && record.accessToken.length > 0,
    hasIdToken: typeof record.idToken === "string" && record.idToken.length > 0,
    hasAccountId: typeof record.accountId === "string" && record.accountId.length > 0,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    needsRefresh: expiresAt === undefined ? false : expiresAt <= now,
    needsLogin: record.needsLogin === true,
  };
}

async function setModeIfSupported(path: string, mode: number): Promise<void> {
  await chmod(path, mode).catch((error) => {
    if (isNodeError(error) && (error.code === "ENOSYS" || error.code === "EPERM" || error.code === "EINVAL")) {
      return;
    }
    throw error;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
