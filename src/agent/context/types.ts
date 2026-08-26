export interface ContextRoute {
  providerId: string;
  baseURL: string;
  modelId: string;
}

export type ContextCapacitySource =
  | "config"
  | "provider"
  | "catalog"
  | "error-reported"
  | "error-inferred"
  | "assumed"
  | "unknown";

export interface ContextCapacity {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  source: ContextCapacitySource;
  confidence: "authoritative" | "reported" | "catalog" | "inferred" | "assumed" | "unknown";
  observedAt?: string;
}

export interface ContextUsageSnapshot {
  promptTokens: number;
  trailingEstimatedTokens: number;
  source: "provider" | "local-estimate";
  estimated: boolean;
  route: ContextRoute;
  asOfModelCall: number;
  requestBaseFingerprint: string;
  observedAt: string;
}

export interface ContextBudget {
  capacity: ContextCapacity;
  usedTokens: number;
  hardPromptBudget?: number;
  compactAtTokens?: number;
  targetTokens?: number;
  reserveTokens?: number;
  rawRemainingTokens?: number;
  safeRemainingTokens?: number;
  uncertaintyTokens: number;
}

export interface ContextPolicy {
  enabled: boolean;
  thresholdPercent: number;
  targetPercent: number;
  reserveTokens?: number;
  keepRecentTokens: number;
  maxCompactionsPerTurn: number;
  learnProviderLimits: boolean;
  assumedContextWindow?: number;
}

export interface ContextStatus {
  route: ContextRoute;
  usage: ContextUsageSnapshot;
  budget: ContextBudget;
  compactionsThisSession: number;
  compactionsThisTurn: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  enabled: true,
  thresholdPercent: 85,
  targetPercent: 40,
  keepRecentTokens: 16_000,
  maxCompactionsPerTurn: 2,
  learnProviderLimits: true,
};
