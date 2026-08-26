import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTopchesterStatePath } from "../../app/paths.js";
import { contextRouteKey, resolveContextCapacity } from "./capacity.js";
import { type ContextCapacity, type ContextRoute } from "./types.js";

const REGISTRY_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredRegistry {
  version: 1;
  routes: Record<string, { capacity: ContextCapacity; baseURL: string; modelId: string; providerId: string }>;
}

export class ContextCapacityRegistry {
  readonly #path: string;
  readonly #entries = new Map<string, ContextCapacity>();

  constructor(
    workspaceRoot: string,
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {
    this.#path = join(getTopchesterStatePath(workspaceRoot), "context-routes.json");
    this.load();
  }

  get(route: ContextRoute, now = Date.now()): ContextCapacity | undefined {
    const capacity = this.#entries.get(contextRouteKey(route));
    if (!capacity) return undefined;
    const observed = capacity.observedAt ? Date.parse(capacity.observedAt) : Number.NaN;
    if (Number.isFinite(observed) && now - observed > this.ttlMs) return undefined;
    return { ...capacity };
  }

  set(route: ContextRoute, capacity: ContextCapacity): void {
    if (capacity.source === "config" || capacity.source === "assumed" || capacity.source === "unknown") return;
    const key = contextRouteKey(route);
    const observed = { ...capacity, observedAt: capacity.observedAt ?? new Date().toISOString() };
    const existing = this.get(route);
    this.#entries.set(key, mergePersistedCapacity(existing, observed));
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as Partial<StoredRegistry>;
      if (parsed.version !== REGISTRY_VERSION || !parsed.routes || typeof parsed.routes !== "object") return;
      for (const [key, entry] of Object.entries(parsed.routes)) {
        if (!entry || !isPersistableCapacity(entry.capacity)) continue;
        try {
          if (contextRouteKey(entry) === key) this.#entries.set(key, entry.capacity);
        } catch {
          continue;
        }
      }
    } catch {
      // Invalid state is ignored; config and unknown-capacity behavior remain safe.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const routes: StoredRegistry["routes"] = {};
    for (const [key, capacity] of this.#entries) {
      try {
        const [providerId, baseURL, modelId] = JSON.parse(key) as [string, string, string];
        routes[key] = { capacity, providerId, baseURL, modelId };
      } catch {
        continue;
      }
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: REGISTRY_VERSION, routes }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

function mergePersistedCapacity(existing: ContextCapacity | undefined, incoming: ContextCapacity): ContextCapacity {
  if (!existing) return incoming;
  const existingLearned = isLearned(existing);
  const incomingLearned = isLearned(incoming);
  if (existingLearned && !incomingLearned) {
    return resolveContextCapacity({ provider: incoming, learned: existing });
  }
  if (!existingLearned && incomingLearned) {
    return resolveContextCapacity({ provider: existing, learned: incoming });
  }
  if (existingLearned && incomingLearned) {
    return resolveContextCapacity({ provider: existing, learned: incoming });
  }
  return incoming;
}

function isLearned(capacity: ContextCapacity): boolean {
  return capacity.source === "error-reported" || capacity.source === "error-inferred";
}

function isPersistableCapacity(value: unknown): value is ContextCapacity {
  if (!value || typeof value !== "object") return false;
  const capacity = value as Partial<ContextCapacity>;
  if (!capacity.source || !["provider", "catalog", "error-reported", "error-inferred"].includes(capacity.source)) {
    return false;
  }
  if (
    !capacity.confidence ||
    !["reported", "catalog", "inferred"].includes(capacity.confidence) ||
    [capacity.contextWindow, capacity.maxInputTokens, capacity.maxOutputTokens].some(
      (tokens) => tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0)
    )
  ) {
    return false;
  }
  if (!capacity.observedAt || !Number.isFinite(Date.parse(capacity.observedAt))) return false;
  return capacity.contextWindow !== undefined || capacity.maxInputTokens !== undefined;
}
