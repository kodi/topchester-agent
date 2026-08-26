import { type ContextBudget, type ContextCapacity, type ContextPolicy, type ContextRoute } from "./types.js";
import { type TopchesterConfig } from "../../config/index.js";

export interface CapacityCandidate extends ContextCapacity {
  route: ContextRoute;
}

export interface ResolveCapacityOptions {
  config?: ContextCapacity;
  provider?: ContextCapacity;
  catalog?: ContextCapacity;
  learned?: ContextCapacity;
  assumed?: ContextCapacity;
}

export function normalizeBaseURL(baseURL: string): string {
  const url = new URL(baseURL);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.protocol = url.protocol.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export function normalizeContextRoute(route: ContextRoute): ContextRoute {
  return {
    providerId: route.providerId.trim().toLowerCase(),
    baseURL: normalizeBaseURL(route.baseURL),
    modelId: route.modelId.trim(),
  };
}

export function contextRouteKey(route: ContextRoute): string {
  const normalized = normalizeContextRoute(route);
  return JSON.stringify([normalized.providerId, normalized.baseURL, normalized.modelId]);
}

export function resolveContextCapacity(options: ResolveCapacityOptions): ContextCapacity {
  const base = options.config ?? options.provider ?? options.catalog ?? options.assumed;
  const unknown: ContextCapacity = { source: "unknown", confidence: "unknown" };
  if (!base) return options.learned ?? unknown;
  if (options.config) return options.config;
  const learned = options.learned;
  if (!learned) return base;

  return {
    ...base,
    ...(lowerPositive(base.contextWindow, learned.contextWindow) === undefined
      ? {}
      : { contextWindow: lowerPositive(base.contextWindow, learned.contextWindow) }),
    ...(lowerPositive(base.maxInputTokens, learned.maxInputTokens) === undefined
      ? {}
      : { maxInputTokens: lowerPositive(base.maxInputTokens, learned.maxInputTokens) }),
    ...(lowerPositive(base.maxOutputTokens, learned.maxOutputTokens) === undefined
      ? {}
      : { maxOutputTokens: lowerPositive(base.maxOutputTokens, learned.maxOutputTokens) }),
    source: learned.source,
    confidence: learned.confidence,
    ...(learned.observedAt ? { observedAt: learned.observedAt } : {}),
  };
}

export function deriveContextBudget(
  capacity: ContextCapacity,
  usedTokens: number,
  policy: ContextPolicy,
  options: { providerSnapshot?: boolean; requestedOutputTokens?: number } = {}
): ContextBudget {
  const capacityBasis = capacity.contextWindow ?? capacity.maxInputTokens;
  const completeEstimate = !options.providerSnapshot || capacity.source === "assumed";
  let uncertaintyTokens = capacityBasis
    ? Math.max(completeEstimate ? 4_000 : 2_000, Math.floor(capacityBasis * (completeEstimate ? 0.05 : 0.02)))
    : Math.max(4_000, Math.ceil(usedTokens * 0.05));

  let reserveTokens: number | undefined;
  let sharedWindowBudget: number | undefined;
  if (capacity.contextWindow !== undefined) {
    const minimumPromptBudget = Math.max(1, Math.min(4_096, Math.floor(capacity.contextWindow * 0.5)));
    const baselineReserve = Math.min(16_384, Math.max(1_024, Math.floor(capacity.contextWindow * 0.25)));
    const reserveCandidate =
      policy.reserveTokens ??
      Math.max(capacity.maxOutputTokens ?? 0, options.requestedOutputTokens ?? 0, baselineReserve);
    reserveTokens = Math.max(0, Math.min(reserveCandidate, capacity.contextWindow - minimumPromptBudget));
    sharedWindowBudget = Math.max(1, capacity.contextWindow - reserveTokens);
  }

  const ceilings = [capacity.maxInputTokens, sharedWindowBudget].filter(
    (value): value is number => value !== undefined
  );
  const hardPromptBudget = ceilings.length > 0 ? Math.min(...ceilings) : undefined;
  if (hardPromptBudget === undefined) {
    return { capacity, usedTokens, uncertaintyTokens };
  }

  const targetTokens = Math.max(1, Math.floor((hardPromptBudget * policy.targetPercent) / 100));
  uncertaintyTokens = Math.min(
    uncertaintyTokens,
    Math.max(0, Math.floor((hardPromptBudget * policy.thresholdPercent) / 100) - targetTokens - 1)
  );
  const compactAtTokens = Math.max(
    1,
    Math.floor((hardPromptBudget * policy.thresholdPercent) / 100) - uncertaintyTokens
  );
  if (targetTokens >= compactAtTokens) {
    throw new Error("Compaction target must be below the uncertainty-adjusted trigger.");
  }
  return {
    capacity,
    usedTokens,
    hardPromptBudget,
    compactAtTokens,
    targetTokens,
    ...(reserveTokens === undefined ? {} : { reserveTokens }),
    rawRemainingTokens: Math.max(0, hardPromptBudget - usedTokens),
    safeRemainingTokens: Math.max(0, hardPromptBudget - usedTokens - uncertaintyTokens),
    uncertaintyTokens,
  };
}

function lowerPositive(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export function contextPolicyFromConfig(config: TopchesterConfig): ContextPolicy {
  return {
    enabled: config.compaction?.enabled ?? true,
    thresholdPercent: config.compaction?.thresholdPercent ?? 85,
    targetPercent: config.compaction?.targetPercent ?? 40,
    ...(config.compaction?.reserveTokens === undefined ? {} : { reserveTokens: config.compaction.reserveTokens }),
    keepRecentTokens: config.compaction?.keepRecentTokens ?? 16_000,
    maxCompactionsPerTurn: config.compaction?.maxCompactionsPerTurn ?? 2,
    learnProviderLimits: config.compaction?.learnProviderLimits ?? true,
    ...(config.compaction?.assumedContextWindow === undefined
      ? {}
      : { assumedContextWindow: config.compaction.assumedContextWindow }),
  };
}

export function configuredCapacityForRoute(config: TopchesterConfig, route: ContextRoute): ContextCapacity {
  const provider = config.providers?.[route.providerId];
  const limit = typeof provider === "object" && provider ? provider.modelLimits?.[route.modelId] : undefined;
  if (limit) {
    const assumed = limit.assumed === true;
    return {
      ...(limit.contextWindow === undefined ? {} : { contextWindow: limit.contextWindow }),
      ...(limit.maxInputTokens === undefined ? {} : { maxInputTokens: limit.maxInputTokens }),
      ...(limit.maxOutputTokens === undefined ? {} : { maxOutputTokens: limit.maxOutputTokens }),
      source: assumed ? "assumed" : "config",
      confidence: assumed ? "assumed" : "authoritative",
    };
  }
  const assumed = config.compaction?.assumedContextWindow;
  return assumed
    ? { contextWindow: assumed, source: "assumed", confidence: "assumed" }
    : { source: "unknown", confidence: "unknown" };
}
