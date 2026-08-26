import { contextRouteKey } from "./capacity.js";
import { type ContextCapacity, type ContextRoute } from "./types.js";

const routeMetadata = new Map<string, ContextCapacity>();
const PROVIDER_METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function recordProviderModelCapacity(route: ContextRoute, capacity: ContextCapacity): void {
  if (capacity.contextWindow === undefined && capacity.maxInputTokens === undefined) return;
  routeMetadata.set(contextRouteKey(route), { ...capacity });
}

export function getProviderModelCapacity(route: ContextRoute, now = Date.now()): ContextCapacity | undefined {
  const key = contextRouteKey(route);
  const capacity = routeMetadata.get(key);
  const observedAt = capacity?.observedAt ? Date.parse(capacity.observedAt) : Number.NaN;
  if (capacity && Number.isFinite(observedAt) && now - observedAt > PROVIDER_METADATA_TTL_MS) {
    routeMetadata.delete(key);
    return undefined;
  }
  return capacity ? { ...capacity } : undefined;
}

export function parseProviderModelCapacity(
  value: unknown,
  observedAt = new Date().toISOString()
): ContextCapacity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const context = consistentPositiveInteger(record, ["context_length", "context_window", "max_context_length"]);
  const input = consistentPositiveInteger(record, ["max_input_tokens", "input_token_limit"]);
  const output = consistentPositiveInteger(record, ["max_output_tokens", "output_token_limit"]);
  if (context.conflict || input.conflict || output.conflict) return undefined;
  const contextWindow = context.value;
  const maxInputTokens = input.value;
  const maxOutputTokens = output.value;
  if (contextWindow === undefined && maxInputTokens === undefined) return undefined;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    source: "provider",
    confidence: "reported",
    observedAt,
  };
}

function consistentPositiveInteger(
  record: Record<string, unknown>,
  names: string[]
): { value?: number; conflict: boolean } {
  const values = names.flatMap((name) => {
    const value = record[name];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? [value] : [];
  });
  const unique = new Set(values);
  if (unique.size > 1) return { conflict: true };
  const value = values[0];
  return value === undefined ? { conflict: false } : { value, conflict: false };
}
