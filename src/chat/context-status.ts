import { type ContextStatus } from "../agent/context/types.js";

export function formatContextStatusBar(status: ContextStatus, width: number): string {
  const used = status.usage.promptTokens + status.usage.trailingEstimatedTokens;
  const estimate = status.usage.estimated ? "~" : "";
  const total = status.budget.capacity.contextWindow ?? status.budget.hardPromptBudget;
  if (total === undefined) return `ctx ${estimate}${formatTokens(used)}/?`;
  const percent = Math.min(999, Math.round((used / total) * 100));
  const hardLimit = status.budget.hardPromptBudget ?? total;
  const severity =
    used >= hardLimit ? "limit" : used >= (status.budget.compactAtTokens ?? hardLimit) ? "compact soon" : "safe";
  if (width < 96) return `ctx ${percent}%${severity === "safe" ? "" : ` ${severity}`}`;
  if (width < 120) return `ctx ${percent}% · ${formatTokens(status.budget.safeRemainingTokens ?? 0)} ${severity}`;
  return `ctx ${estimate}${formatTokens(used)}/${formatTokens(total)} · ${percent}% · ${formatTokens(status.budget.safeRemainingTokens ?? 0)} ${severity}`;
}

export function formatContextDiagnostics(status: ContextStatus, enabled: boolean): string {
  const used = status.usage.promptTokens + status.usage.trailingEstimatedTokens;
  const capacity = status.budget.capacity;
  const capacityTokens = capacity.contextWindow ?? capacity.maxInputTokens;
  const usageSource =
    status.usage.source === "provider"
      ? status.usage.trailingEstimatedTokens > 0
        ? "provider snapshot + local trailing estimate"
        : "provider snapshot"
      : "complete local estimate";
  return [
    `route: ${status.route.providerId}/${status.route.modelId} @ ${status.route.baseURL}`,
    `active prompt: ${status.usage.estimated ? "~" : ""}${used.toLocaleString()} tokens (${usageSource}, ${status.usage.observedAt})`,
    `capacity: ${capacityTokens?.toLocaleString() ?? "unknown"} tokens (${capacity.source}, ${capacity.confidence}${capacity.observedAt ? `, observed ${capacity.observedAt}` : ""})`,
    `hard prompt budget: ${status.budget.hardPromptBudget?.toLocaleString() ?? "unknown"} tokens`,
    ...(status.budget.reserveTokens === undefined
      ? []
      : [`output reserve: ${status.budget.reserveTokens.toLocaleString()} tokens`]),
    `automatic compaction: ${enabled ? (status.budget.compactAtTokens?.toLocaleString() ?? "disabled for unknown capacity") : "off"}`,
    `raw remaining: ${status.budget.rawRemainingTokens?.toLocaleString() ?? "unknown"} tokens`,
    `safe remaining: ${status.budget.safeRemainingTokens?.toLocaleString() ?? "unknown"} tokens`,
    `compactions: ${status.compactionsThisSession} this session, ${status.compactionsThisTurn} this turn`,
    ...(capacity.source === "unknown"
      ? ["guidance: configure providers.<id>.modelLimits for this exact route, or opt in to model-limit discovery."]
      : []),
  ].join("\n");
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
