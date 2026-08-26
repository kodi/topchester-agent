import { createHash } from "node:crypto";
import { type ContextRoute, type ContextUsageSnapshot } from "./types.js";

export interface RequestEstimateInput {
  route: ContextRoute;
  system: string;
  prompt: string;
  toolDefinitions?: unknown;
  images?: Array<{ mediaType?: string; bytes?: number; detail?: string }>;
  providerOptions?: unknown;
}

export interface RequestTokenEstimate {
  tokens: number;
  fingerprint: string;
  estimated: true;
  source: "local-estimate";
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  return Math.max(1, Math.ceil(bytes / 3.5), Math.ceil(words * 1.35));
}

export function fingerprintProviderRequest(input: RequestEstimateInput): string {
  return createHash("sha256")
    .update(
      stableStringify({
        route: input.route,
        system: input.system,
        prompt: input.prompt,
        toolDefinitions: input.toolDefinitions ?? null,
        images: input.images ?? [],
        providerOptions: input.providerOptions ?? null,
      })
    )
    .digest("hex");
}

export function estimateProviderRequest(input: RequestEstimateInput): RequestTokenEstimate {
  const serializedTools = stableStringify(input.toolDefinitions ?? null);
  const serializedOptions = stableStringify(input.providerOptions ?? null);
  const imageTokens = (input.images ?? []).reduce((total, image) => {
    const base = image.detail === "low" ? 256 : 1_024;
    return total + Math.max(base, Math.ceil((image.bytes ?? 0) / 768));
  }, 0);
  return {
    tokens:
      estimateTextTokens(input.system) +
      estimateTextTokens(input.prompt) +
      estimateTextTokens(serializedTools) +
      estimateTextTokens(serializedOptions) +
      imageTokens,
    fingerprint: fingerprintProviderRequest(input),
    estimated: true,
    source: "local-estimate",
  };
}

export function reconcilePromptUsage(options: {
  request: RequestEstimateInput;
  prior?: ContextUsageSnapshot;
  providerPromptTokens?: number;
  trailingText?: string;
  modelCall: number;
  now?: Date;
}): ContextUsageSnapshot {
  const estimate = estimateProviderRequest(options.request);
  const observedAt = (options.now ?? new Date()).toISOString();
  if (options.providerPromptTokens !== undefined) {
    return {
      promptTokens: Math.max(0, Math.floor(options.providerPromptTokens)),
      trailingEstimatedTokens: 0,
      source: "provider",
      estimated: false,
      route: options.request.route,
      asOfModelCall: options.modelCall,
      requestBaseFingerprint: estimate.fingerprint,
      observedAt,
    };
  }
  if (options.prior?.source === "provider" && options.prior.requestBaseFingerprint === estimate.fingerprint) {
    const trailingEstimatedTokens = estimateTextTokens(options.trailingText ?? "");
    return {
      ...options.prior,
      trailingEstimatedTokens,
      estimated: trailingEstimatedTokens > 0,
      observedAt,
    };
  }
  return {
    promptTokens: estimate.tokens,
    trailingEstimatedTokens: 0,
    source: "local-estimate",
    estimated: true,
    route: options.request.route,
    asOfModelCall: options.modelCall,
    requestBaseFingerprint: estimate.fingerprint,
    observedAt,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
