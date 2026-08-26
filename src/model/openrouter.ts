import { openRouterProviderDefaults } from "../config/index.js";
import { recordProviderModelCapacity, parseProviderModelCapacity } from "../agent/context/provider-metadata.js";

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
  };
}

export interface OpenRouterModelChoice {
  ref: string;
  id: string;
  label: string;
  description: string;
}

export type FetchImplementation = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface FetchOpenRouterModelsOptions {
  apiKey?: string;
  userFiltered?: boolean;
  fetchImpl?: FetchImplementation;
}

const OPENROUTER_MODELS_URL = `${openRouterProviderDefaults.baseURL}/models`;
const OPENROUTER_USER_MODELS_URL = `${openRouterProviderDefaults.baseURL}/models/user`;
const openRouterStarterChoiceRefs = [
  "openrouter/qwen/qwen3-coder:free",
  "openrouter/qwen/qwen3-coder",
  "openrouter/anthropic/claude-sonnet-4.5",
  "openrouter/openai/gpt-5-codex",
  "openrouter/google/gemini-3.1-flash-lite",
  "openrouter/x-ai/grok-4.3",
  "openrouter/mistralai/mistral-medium-3-5",
  "openrouter/deepseek/deepseek-chat",
  "openrouter/inclusionai/ring-2.6-1t",
  "openrouter/openrouter/owl-alpha",
];

export async function fetchOpenRouterModelChoices(
  options: FetchOpenRouterModelsOptions = {}
): Promise<OpenRouterModelChoice[]> {
  const models = await fetchOpenRouterModels(options);

  return models.map(openRouterModelToChoice);
}

export async function fetchOpenRouterModels(options: FetchOpenRouterModelsOptions = {}): Promise<OpenRouterModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(options.userFiltered ? OPENROUTER_USER_MODELS_URL : OPENROUTER_MODELS_URL);
  url.searchParams.set("output_modalities", "text");
  url.searchParams.set("supported_parameters", "tools");
  const headers: Record<string, string> = {};

  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const response = await fetchImpl(url, { headers });

  if (!response.ok) {
    throw new Error(`OpenRouter models request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as unknown;
  if (!isOpenRouterModelsBody(body)) {
    throw new Error("OpenRouter models response did not include a data list.");
  }

  const models = body.data.filter(isOpenRouterTextModel);
  for (const model of models) {
    const capacity = parseProviderModelCapacity(model);
    if (capacity) {
      recordProviderModelCapacity(
        { providerId: "openrouter", baseURL: openRouterProviderDefaults.baseURL, modelId: model.id },
        capacity
      );
    }
  }
  return models;
}

export function selectOpenRouterStarterChoices(
  models: readonly OpenRouterModelChoice[],
  limit = openRouterStarterChoiceRefs.length
): string[] {
  const availableRefs = new Set(models.map((choice) => choice.ref));
  const preferredRefs = openRouterStarterChoiceRefs.filter((ref) => availableRefs.has(ref));

  if (preferredRefs.length >= limit) {
    return preferredRefs.slice(0, limit);
  }

  const seen = new Set(preferredRefs);
  const rankedRefs = rankOpenRouterModelChoices(models)
    .map((choice) => choice.ref)
    .filter((ref) => !seen.has(ref));

  return [...preferredRefs, ...rankedRefs].slice(0, limit);
}

export function rankOpenRouterModelChoices(models: readonly OpenRouterModelChoice[]): OpenRouterModelChoice[] {
  return [...models].sort(
    (left, right) => scoreOpenRouterChoice(right) - scoreOpenRouterChoice(left) || left.id.localeCompare(right.id)
  );
}

export function fallbackOpenRouterStarterChoices(): string[] {
  return [...openRouterStarterChoiceRefs];
}

export function openRouterModelToChoice(model: OpenRouterModel): OpenRouterModelChoice {
  const context =
    typeof model.context_length === "number" ? `${Math.round(model.context_length / 1000)}k ctx` : "ctx ?";
  const price = formatPricing(model);
  const description = [context, price].filter(Boolean).join(" · ");

  return {
    ref: `openrouter/${model.id}`,
    id: model.id,
    label: model.name?.trim() || model.id,
    description,
  };
}

function scoreOpenRouterChoice(choice: OpenRouterModelChoice): number {
  const id = choice.id.toLowerCase();
  let score = 0;

  if (id.includes("qwen") && (id.includes("coder") || id.includes("code"))) {
    score += 500;
  }
  if (id.includes("claude") && id.includes("sonnet")) {
    score += 460;
  }
  if (id.includes("gpt") && (id.includes("codex") || /\bgpt-5/u.test(id))) {
    score += 430;
  }
  if (id.includes("gemini") && id.includes("flash")) {
    score += 390;
  }
  if (id.includes("deepseek") && (id.includes("coder") || id.includes("v3") || id.includes("chat"))) {
    score += 360;
  }
  if (id.includes("kimi") || id.includes("moonshot")) {
    score += 330;
  }
  if (id.includes("mistral") && (id.includes("medium") || id.includes("large") || id.includes("codestral"))) {
    score += 300;
  }
  if (id.endsWith(":free")) {
    score += 8;
  }
  if (id.includes("preview") || id.includes("experimental")) {
    score -= 10;
  }
  if (id.includes("opus")) {
    score -= 40;
  }
  if (id.includes("chat-latest")) {
    score -= 80;
  }

  return score;
}

function formatPricing(model: OpenRouterModel): string | undefined {
  const prompt = parseOpenRouterTokenPrice(model.pricing?.prompt);
  const completion = parseOpenRouterTokenPrice(model.pricing?.completion);

  if (prompt === undefined && completion === undefined) {
    return undefined;
  }

  return `$${formatPrice(prompt)}/$${formatPrice(completion)} per 1M`;
}

function parseOpenRouterTokenPrice(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
}

function formatPrice(value: number | undefined): string {
  if (value === undefined) {
    return "?";
  }

  if (value === 0) {
    return "0";
  }

  return value < 0.01 ? value.toPrecision(2) : value.toFixed(value < 1 ? 2 : 1);
}

function isOpenRouterModelsBody(value: unknown): value is { data: OpenRouterModel[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { data?: unknown }).data) &&
    (value as { data: unknown[] }).data.every((entry) => {
      return typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string";
    })
  );
}

function isOpenRouterTextModel(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities;

  return !Array.isArray(outputs) || outputs.includes("text");
}
