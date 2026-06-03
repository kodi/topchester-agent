import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  type ModelMessage,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolCallRepairFunction,
} from "ai";
import { toAiSdkToolSet } from "../agent/tools/ai-sdk-tools.js";
import { parseNativeToolCall, parseToolCallWithSource } from "../agent/tools/parser.js";
import {
  type ModelToolCall,
  type ToolDefinition,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
} from "../agent/tools/types.js";

export type ModelPurpose = "agent.primary" | "agent.fast" | "kb.summarize" | "fallback";

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  supportsStructuredOutputs?: boolean;
  service_tier?: "flex" | "priority";
  promptCaching?: boolean;
  toolProtocol?: ToolProtocolOverride;
  openRouterToolRouting?: "auto" | "force" | "off";
}

export interface ModelConfig {
  name: string;
  provider?: string;
  toolProtocol?: ToolProtocolOverride;
}

export interface ModelGatewayConfig {
  defaultPurpose: ModelPurpose;
  models: Partial<Record<ModelPurpose, ModelConfig>>;
  defaultProvider?: string;
  providers: Record<string, OpenAICompatibleProviderConfig>;
}

export interface ModelRequest {
  purpose?: ModelPurpose;
  system?: string;
  prompt: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export interface ModelTextResult {
  text: string;
  providerId: string;
  modelId: string;
  purpose: ModelPurpose;
  usage?: ModelTokenUsage;
}

export interface ModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ModelAgentRequest extends ModelRequest {
  tools: readonly ToolDefinition<string, unknown>[];
  toolProtocol?: ToolProtocolOverride;
  onReasoning?: ModelReasoningSink;
}

export interface ModelAgentResult extends ModelTextResult {
  toolCalls: ModelToolCall[];
  toolProtocol: ToolProtocol;
  protocolAttempts: ToolProtocolAttempt[];
  providerRejectedTools: boolean;
  fallbackReason?: string;
  warnings: string[];
  openRouterRoutingApplied: boolean;
}

export interface ModelReasoningEvent {
  type: "delta" | "summary" | "clear";
  text?: string;
}

export type ModelReasoningSink = (event: ModelReasoningEvent) => void | Promise<void>;

type NativeAiToolSet = ReturnType<typeof toAiSdkToolSet>;

export class ModelGateway {
  readonly #config: ModelGatewayConfig;

  constructor(config: ModelGatewayConfig) {
    this.#config = config;
  }

  withModelOverride(modelId: string, purpose: ModelPurpose = "agent.primary"): ModelGateway {
    const current = this.#config.models[purpose] ?? this.#config.models.fallback;

    return new ModelGateway({
      ...this.#config,
      models: {
        ...this.#config.models,
        [purpose]: {
          ...(current?.provider === undefined ? {} : { provider: current.provider }),
          ...(current?.toolProtocol === undefined ? {} : { toolProtocol: current.toolProtocol }),
          name: modelId,
        },
      },
    });
  }

  resolveModel(purpose = this.#config.defaultPurpose): {
    model: LanguageModel;
    providerId: string;
    modelId: string;
    purpose: ModelPurpose;
    providerConfig: OpenAICompatibleProviderConfig;
    modelConfig: ModelConfig;
  } {
    const modelConfig = this.#config.models[purpose] ?? this.#config.models.fallback;

    if (!modelConfig) {
      throw new Error(`No model configured for purpose "${purpose}".`);
    }

    const providerId = modelConfig.provider ?? this.#config.defaultProvider;

    if (!providerId) {
      throw new Error(`No provider configured for model "${modelConfig.name}".`);
    }

    const modelId = modelConfig.name;
    const providerConfig = this.#config.providers[providerId];

    if (!providerConfig) {
      throw new Error(`No provider configured for model provider "${providerId}".`);
    }

    const provider = createOpenAICompatible({
      name: providerId,
      baseURL: providerConfig.baseURL,
      apiKey: resolveApiKey(providerConfig),
      headers: providerConfig.headers,
      supportsStructuredOutputs: providerConfig.supportsStructuredOutputs,
    });

    return {
      model: provider.chatModel(modelId),
      providerId,
      modelId,
      purpose,
      providerConfig,
      modelConfig,
    };
  }

  async generateText(request: ModelRequest): Promise<ModelTextResult> {
    const resolved = this.resolveModel(request.purpose);
    const providerOptions = buildProviderOptions(resolved.providerId, resolved.providerConfig, request);
    const result = await generateText({
      model: resolved.model,
      ...buildPromptInput(request, resolved.providerConfig),
      providerOptions,
      abortSignal: request.abortSignal,
    });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
      responseHeaders: result.response.headers,
    });

    return {
      text: result.text,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      purpose: resolved.purpose,
      ...(usage ? { usage } : {}),
    };
  }

  async generateAgentStep(request: ModelAgentRequest): Promise<ModelAgentResult> {
    const resolved = this.resolveModel(request.purpose ?? "agent.primary");
    const override =
      request.toolProtocol ?? resolved.modelConfig.toolProtocol ?? resolved.providerConfig.toolProtocol ?? "auto";
    const attempts: ToolProtocolAttempt[] = [];

    if (override === "auto" && shouldUseTextProtocolForOpenRouterStreaming(request, resolved)) {
      attempts.push({
        protocol: "native-openai-compatible",
        status: "skipped",
        reason: "openrouter streaming auto uses text-json",
      });

      return this.generateTextAgentStep(
        request,
        resolved,
        attempts,
        "openrouter streaming auto uses text JSON protocol",
        false,
        ["text-json"]
      );
    }

    if (override === "native" || override === "auto") {
      try {
        return await this.generateNativeAgentStep(request, resolved, attempts);
      } catch (error) {
        const reason = formatErrorMessage(error);
        attempts.push({ protocol: "native-openai-compatible", status: "failed", reason });

        if (override === "native" || !isNativeToolFallbackError(error)) {
          throw error;
        }

        return this.generateTextAgentStep(request, resolved, attempts, "provider rejected native tools", true, [
          "text-json",
          "text-xml",
        ]);
      }
    }

    attempts.push({ protocol: "native-openai-compatible", status: "skipped", reason: `toolProtocol=${override}` });

    return this.generateTextAgentStep(
      request,
      resolved,
      attempts,
      override === "text-xml" ? "forced text XML protocol" : "forced text JSON protocol",
      false,
      override === "text-xml" ? ["text-xml"] : ["text-json"]
    );
  }

  async *streamText(request: ModelRequest): AsyncIterable<string> {
    const resolved = this.resolveModel(request.purpose);
    const result = streamText({
      model: resolved.model,
      ...buildPromptInput(request, resolved.providerConfig),
      providerOptions: buildProviderOptions(resolved.providerId, resolved.providerConfig, request),
      abortSignal: request.abortSignal,
      onError: noopStreamErrorHandler,
    });

    yield* result.textStream;
  }

  private async generateNativeAgentStep(
    request: ModelAgentRequest,
    resolved: ReturnType<ModelGateway["resolveModel"]>,
    attempts: ToolProtocolAttempt[]
  ): Promise<ModelAgentResult> {
    const providerOptions = buildNativeProviderOptions(resolved.providerId, resolved.providerConfig, request);
    const openRouterRoutingApplied = hasOpenRouterRoutingOptions(providerOptions, resolved.providerId);
    const tools = toAiSdkToolSet(request.tools);
    const experimental_repairToolCall = createNativeToolCallRepair(tools);
    const result = request.onReasoning
      ? await this.streamNativeAgentStep(request, resolved, providerOptions, tools, experimental_repairToolCall)
      : await generateText({
          model: resolved.model,
          ...buildPromptInput(request, resolved.providerConfig),
          tools,
          toolChoice: "auto",
          stopWhen: stepCountIs(1),
          experimental_repairToolCall,
          providerOptions,
          abortSignal: request.abortSignal,
        });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
      responseHeaders: result.response.headers,
    });
    const toolCalls = result.toolCalls.flatMap((call, index) => {
      if (isInvalidAiSdkToolCall(call)) {
        return [];
      }

      const parsed = parseNativeToolCall(call.toolName, call.input);

      if (!parsed) {
        throw new Error(`Native tool call for ${call.toolName} did not match the registered schema.`);
      }

      return [
        {
          id: call.toolCallId || `native-${index}`,
          tool: parsed.tool,
          args: parsed.args,
          source: "native",
        } as ModelToolCall,
      ];
    });

    attempts.push({ protocol: "native-openai-compatible", status: "used" });

    return {
      text: result.text,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      purpose: resolved.purpose,
      ...(usage ? { usage } : {}),
      toolCalls,
      toolProtocol: "native-openai-compatible",
      protocolAttempts: attempts,
      providerRejectedTools: false,
      warnings: extractWarningMessages(result.warnings),
      openRouterRoutingApplied,
    };
  }

  private async generateTextAgentStep(
    request: ModelAgentRequest,
    resolved: ReturnType<ModelGateway["resolveModel"]>,
    attempts: ToolProtocolAttempt[],
    fallbackReason: string | undefined,
    providerRejectedTools: boolean,
    allowedSources: Array<"text-json" | "text-xml">
  ): Promise<ModelAgentResult> {
    const result = request.onReasoning
      ? await this.streamTextAgentStep(request, resolved)
      : await generateText({
          model: resolved.model,
          ...buildPromptInput(request, resolved.providerConfig),
          providerOptions: buildProviderOptions(resolved.providerId, resolved.providerConfig, request),
          abortSignal: request.abortSignal,
        });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
      responseHeaders: result.response.headers,
    });
    const parsed = parseToolCallWithSource(result.text, allowedSources);
    const defaultProtocol: ToolProtocol =
      allowedSources.length === 1 && allowedSources[0] === "text-xml" ? "text-xml" : "text-json";
    const toolProtocol: ToolProtocol =
      parsed?.source === "text-xml" ? "text-xml" : parsed ? "text-json" : defaultProtocol;

    attempts.push({ protocol: toolProtocol, status: "used", ...(fallbackReason ? { reason: fallbackReason } : {}) });

    return {
      text: result.text,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      purpose: resolved.purpose,
      ...(usage ? { usage } : {}),
      toolCalls: parsed
        ? [
            {
              id: `${parsed.source}-0`,
              tool: parsed.call.tool,
              args: parsed.call.args,
              source: parsed.source,
            } as ModelToolCall,
          ]
        : [],
      toolProtocol,
      protocolAttempts: attempts,
      providerRejectedTools,
      ...(fallbackReason ? { fallbackReason } : {}),
      warnings: extractWarningMessages(result.warnings),
      openRouterRoutingApplied: false,
    };
  }

  private async streamNativeAgentStep(
    request: ModelAgentRequest,
    resolved: ReturnType<ModelGateway["resolveModel"]>,
    providerOptions: ProviderOptions,
    tools: NativeAiToolSet,
    experimental_repairToolCall: ToolCallRepairFunction<NativeAiToolSet>
  ) {
    const result = streamText({
      model: resolved.model,
      ...buildPromptInput(request, resolved.providerConfig),
      tools,
      toolChoice: "auto",
      stopWhen: stepCountIs(1),
      experimental_repairToolCall,
      providerOptions,
      abortSignal: request.abortSignal,
      includeRawChunks: true,
      onError: noopStreamErrorHandler,
    });
    guardStreamTextResultRejections(result);
    let rawUsageBody: unknown;
    let sawReasoningDelta = false;
    let reasoningText: string | undefined;
    let text: string;
    let toolCalls: Awaited<typeof result.toolCalls>;
    let usage: Awaited<typeof result.usage>;
    let warnings: Awaited<typeof result.warnings>;
    let response: Awaited<typeof result.response>;

    try {
      ({ rawUsageBody, sawReasoningDelta } = await consumeReasoningStream(result.fullStream, request.onReasoning));
      [text, toolCalls, usage, warnings, response, reasoningText] = await Promise.all([
        result.text,
        result.toolCalls,
        result.usage,
        result.warnings,
        result.response,
        result.reasoningText,
      ]);
    } catch (error) {
      await settleRejectedStreamTextResult(result);
      throw error;
    }

    await emitReasoningSummary(request.onReasoning, sawReasoningDelta, reasoningText);

    return {
      text,
      toolCalls,
      usage,
      warnings,
      response: withRawUsageBody(response, rawUsageBody),
    };
  }

  private async streamTextAgentStep(request: ModelAgentRequest, resolved: ReturnType<ModelGateway["resolveModel"]>) {
    const result = streamText({
      model: resolved.model,
      ...buildPromptInput(request, resolved.providerConfig),
      providerOptions: buildProviderOptions(resolved.providerId, resolved.providerConfig, request),
      abortSignal: request.abortSignal,
      includeRawChunks: true,
      onError: noopStreamErrorHandler,
    });
    guardStreamTextResultRejections(result);
    let rawUsageBody: unknown;
    let sawReasoningDelta = false;
    let reasoningText: string | undefined;
    let text: string;
    let usage: Awaited<typeof result.usage>;
    let warnings: Awaited<typeof result.warnings>;
    let response: Awaited<typeof result.response>;

    try {
      ({ rawUsageBody, sawReasoningDelta } = await consumeReasoningStream(result.fullStream, request.onReasoning));
      [text, usage, warnings, response, reasoningText] = await Promise.all([
        result.text,
        result.usage,
        result.warnings,
        result.response,
        result.reasoningText,
      ]);
    } catch (error) {
      await settleRejectedStreamTextResult(result);
      throw error;
    }

    await emitReasoningSummary(request.onReasoning, sawReasoningDelta, reasoningText);

    return {
      text,
      usage,
      warnings,
      response: withRawUsageBody(response, rawUsageBody),
    };
  }
}

function noopStreamErrorHandler(): void {}

function createNativeToolCallRepair(tools: NativeAiToolSet): ToolCallRepairFunction<NativeAiToolSet> {
  return async ({ toolCall }) => {
    const lowerToolName = toolCall.toolName.toLowerCase();

    if (lowerToolName !== toolCall.toolName && Object.hasOwn(tools, lowerToolName)) {
      return {
        ...toolCall,
        toolName: lowerToolName,
      };
    }

    return null;
  };
}

function isInvalidAiSdkToolCall(call: unknown): boolean {
  return (
    typeof call === "object" && call !== null && "invalid" in call && (call as { invalid?: unknown }).invalid === true
  );
}

function guardStreamTextResultRejections(result: {
  text?: PromiseLike<unknown>;
  toolCalls?: PromiseLike<unknown>;
  usage?: PromiseLike<unknown>;
  warnings?: PromiseLike<unknown>;
  response?: PromiseLike<unknown>;
  reasoningText?: PromiseLike<unknown>;
}): void {
  for (const promise of [
    result.text,
    result.toolCalls,
    result.usage,
    result.warnings,
    result.response,
    result.reasoningText,
  ]) {
    if (promise) {
      void Promise.resolve(promise).catch(() => {});
    }
  }
}

async function settleRejectedStreamTextResult(result: {
  text?: PromiseLike<unknown>;
  toolCalls?: PromiseLike<unknown>;
  usage?: PromiseLike<unknown>;
  warnings?: PromiseLike<unknown>;
  response?: PromiseLike<unknown>;
  reasoningText?: PromiseLike<unknown>;
}): Promise<void> {
  await Promise.allSettled(
    [result.text, result.toolCalls, result.usage, result.warnings, result.response, result.reasoningText]
      .filter((promise): promise is PromiseLike<unknown> => promise !== undefined)
      .map((promise) => Promise.resolve(promise))
  );
}

async function consumeReasoningStream(
  stream: AsyncIterable<unknown>,
  onReasoning: ModelReasoningSink | undefined
): Promise<{ sawReasoningDelta: boolean; rawUsageBody?: unknown }> {
  let sawReasoningDelta = false;
  let rawUsageBody: unknown;

  for await (const part of stream) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const typedPart = part as {
      type?: string;
      text?: unknown;
      delta?: unknown;
      error?: unknown;
      rawValue?: unknown;
    };

    if (typedPart.type === "error") {
      throw typedPart.error;
    }

    if (typedPart.type === "raw" && hasUsageOrCostBody(typedPart.rawValue)) {
      rawUsageBody = typedPart.rawValue;
      continue;
    }

    if (typedPart.type !== "reasoning-delta") {
      continue;
    }

    const text = typeof typedPart.text === "string" ? typedPart.text : typedPart.delta;

    if (typeof text !== "string" || text.trim().length === 0) {
      continue;
    }

    sawReasoningDelta = true;
    await onReasoning?.({ type: "delta", text });
  }

  return rawUsageBody === undefined ? { sawReasoningDelta } : { sawReasoningDelta, rawUsageBody };
}

async function emitReasoningSummary(
  onReasoning: ModelReasoningSink | undefined,
  sawReasoningDelta: boolean,
  reasoningText: string | undefined
): Promise<void> {
  if (sawReasoningDelta || !reasoningText || reasoningText.trim().length === 0) {
    return;
  }

  await onReasoning?.({ type: "summary", text: reasoningText });
}

function hasUsageOrCostBody(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (("usage" in value &&
      (value as { usage?: unknown }).usage &&
      typeof (value as { usage?: unknown }).usage === "object") ||
      extractResponseCostUsd(value) !== undefined)
  );
}

function withRawUsageBody<Response extends object>(
  response: Response,
  rawUsageBody: unknown
): Response & { body?: unknown } {
  return rawUsageBody === undefined ? response : { ...response, body: rawUsageBody };
}

function resolveApiKey(config: OpenAICompatibleProviderConfig): string | undefined {
  if (config.apiKey !== undefined) {
    return config.apiKey;
  }

  if (config.apiKeyEnv === undefined) {
    return undefined;
  }

  return process.env[config.apiKeyEnv];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ProviderOptions = Record<string, { [key: string]: JsonValue }>;
type PromptInput = { system?: string; prompt: string } | { messages: ModelMessage[] };

function buildProviderOptions(
  providerId: string,
  config: OpenAICompatibleProviderConfig,
  request?: Pick<ModelRequest, "sessionId">
): ProviderOptions {
  const options: { [key: string]: JsonValue } = {};

  if (config.service_tier !== undefined) {
    options.service_tier = config.service_tier;
  }

  if (shouldUsePromptCaching(config) && request?.sessionId) {
    options.prompt_cache_key = request.sessionId;
  }

  return {
    [providerId]: options,
  };
}

function buildNativeProviderOptions(
  providerId: string,
  config: OpenAICompatibleProviderConfig,
  request?: Pick<ModelRequest, "sessionId">
): ProviderOptions {
  const options: { [key: string]: JsonValue } = {
    ...buildProviderOptions(providerId, config, request)[providerId],
    parallel_tool_calls: false,
  };

  if (shouldApplyOpenRouterRoutingOptions(providerId, config)) {
    options.provider = { require_parameters: true };
  }

  return {
    [providerId]: options,
  };
}

function buildPromptInput(request: ModelRequest, config: OpenAICompatibleProviderConfig): PromptInput {
  if (!shouldUsePromptCaching(config)) {
    return {
      ...(request.system === undefined ? {} : { system: request.system }),
      prompt: request.prompt,
    };
  }

  const providerOptions = buildPromptCacheProviderOptions();
  const messages: ModelMessage[] = [
    ...(request.system
      ? [
          {
            role: "system" as const,
            content: request.system,
            providerOptions,
          },
        ]
      : []),
    {
      role: "user",
      content: [
        {
          type: "text",
          text: request.prompt,
          providerOptions,
        },
      ],
    },
  ];

  return { messages };
}

function buildPromptCacheProviderOptions(): NonNullable<ModelMessage["providerOptions"]> {
  return {
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
  };
}

function shouldUsePromptCaching(config: OpenAICompatibleProviderConfig): boolean {
  return config.promptCaching !== false;
}

function shouldApplyOpenRouterRoutingOptions(providerId: string, config: OpenAICompatibleProviderConfig): boolean {
  if (config.openRouterToolRouting === "force") {
    return true;
  }

  if (config.openRouterToolRouting === "off") {
    return false;
  }

  return isOpenRouterProvider(providerId, config);
}

function isOpenRouterProvider(providerId: string, config: OpenAICompatibleProviderConfig): boolean {
  return providerId.toLowerCase().includes("openrouter") || config.baseURL.toLowerCase().includes("openrouter.ai");
}

function shouldUseTextProtocolForOpenRouterStreaming(
  request: ModelAgentRequest,
  resolved: ReturnType<ModelGateway["resolveModel"]>
): boolean {
  return request.onReasoning !== undefined && isOpenRouterProvider(resolved.providerId, resolved.providerConfig);
}

function hasOpenRouterRoutingOptions(providerOptions: ProviderOptions, providerId: string): boolean {
  const options = providerOptions[providerId];

  return Boolean(options && typeof options === "object" && "provider" in options);
}

function isNativeToolFallbackError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();

  return (
    message.includes("tool") ||
    message.includes("function") ||
    message.includes("parallel_tool_calls") ||
    message.includes("tool_choice") ||
    message.includes("requested parameters") ||
    message.includes("provider routing") ||
    message.includes("provider-selection") ||
    message.includes("invalid request")
  );
}

function extractWarningMessages(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) {
    return [];
  }

  return warnings.map((warning) => formatErrorMessage(warning));
}

function normalizeUsage(
  usage: LanguageModelUsage | undefined,
  context?: {
    providerId: string;
    providerConfig: OpenAICompatibleProviderConfig;
    responseBody?: unknown;
    responseHeaders?: Record<string, string>;
  }
): ModelTokenUsage | undefined {
  const costUsd = extractResponseCostUsd(context?.responseBody, context?.responseHeaders);
  const cacheUsage = extractCacheTokenUsage(usage, context?.responseBody);

  if (!usage) {
    const normalizedWithoutUsage: ModelTokenUsage = {
      ...(cacheUsage.cacheReadTokens === undefined ? {} : { cacheReadTokens: cacheUsage.cacheReadTokens }),
      ...(cacheUsage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: cacheUsage.cacheWriteTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };

    return Object.keys(normalizedWithoutUsage).length > 0 ? normalizedWithoutUsage : undefined;
  }

  const normalized: ModelTokenUsage = {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(cacheUsage.cacheReadTokens === undefined ? {} : { cacheReadTokens: cacheUsage.cacheReadTokens }),
    ...(cacheUsage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: cacheUsage.cacheWriteTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractCacheTokenUsage(
  usage: LanguageModelUsage | undefined,
  responseBody: unknown
): Pick<ModelTokenUsage, "cacheReadTokens" | "cacheWriteTokens"> {
  const usageDetails = usage as
    | (LanguageModelUsage & {
        cachedInputTokens?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
        raw?: unknown;
      })
    | undefined;

  return {
    cacheReadTokens: firstPositiveNumber(
      usageDetails?.inputTokenDetails?.cacheReadTokens,
      usageDetails?.cachedInputTokens,
      extractResponseBodyCacheReadTokens(responseBody),
      extractResponseBodyCacheReadTokens(usageDetails?.raw)
    ),
    cacheWriteTokens: firstPositiveNumber(
      usageDetails?.inputTokenDetails?.cacheWriteTokens,
      extractResponseBodyCacheWriteTokens(responseBody),
      extractResponseBodyCacheWriteTokens(usageDetails?.raw)
    ),
  };
}

function extractResponseBodyCacheReadTokens(responseBody: unknown): number | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }

  const usage = (responseBody as { usage?: unknown }).usage ?? responseBody;
  const promptTokenDetails = getObjectValue(usage, "prompt_tokens_details");
  const inputTokenDetails = getObjectValue(usage, "input_tokens_details");

  return firstFiniteNumber(
    getObjectNumber(promptTokenDetails, "cached_tokens"),
    getObjectNumber(inputTokenDetails, "cached_tokens"),
    getObjectNumber(usage, "cache_read_input_tokens"),
    getObjectNumber(usage, "cache_read_tokens"),
    getObjectNumber(usage, "prompt_cache_hit_tokens"),
    getObjectNumber(responseBody, "native_tokens_cached")
  );
}

function extractResponseBodyCacheWriteTokens(responseBody: unknown): number | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }

  const usage = (responseBody as { usage?: unknown }).usage ?? responseBody;
  const promptTokenDetails = getObjectValue(usage, "prompt_tokens_details");
  const inputTokenDetails = getObjectValue(usage, "input_tokens_details");

  return firstFiniteNumber(
    getObjectNumber(promptTokenDetails, "cache_write_tokens"),
    getObjectNumber(inputTokenDetails, "cache_write_tokens"),
    getObjectNumber(usage, "cache_creation_input_tokens"),
    getObjectNumber(usage, "cache_write_input_tokens"),
    getObjectNumber(usage, "cache_write_tokens"),
    getObjectNumber(responseBody, "native_tokens_cache_write")
  );
}

function extractResponseCostUsd(responseBody: unknown, responseHeaders?: Record<string, string>): number | undefined {
  const bodyCost = extractResponseBodyCostUsd(responseBody);

  return bodyCost ?? extractResponseHeaderCostUsd(responseHeaders);
}

function extractResponseBodyCostUsd(responseBody: unknown): number | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }

  const usage = (responseBody as { usage?: unknown }).usage;
  const hiddenParams = (responseBody as { hidden_params?: unknown; _hidden_params?: unknown }).hidden_params;
  const privateHiddenParams = (responseBody as { _hidden_params?: unknown })._hidden_params;

  return firstFiniteNumber(
    getObjectNumber(responseBody, "response_cost"),
    getObjectNumber(responseBody, "responseCost"),
    getObjectNumber(responseBody, "cost"),
    getObjectNumber(responseBody, "cost_usd"),
    getObjectNumber(responseBody, "costUsd"),
    getObjectNumber(usage, "cost"),
    getObjectNumber(usage, "response_cost"),
    getObjectNumber(usage, "responseCost"),
    getObjectNumber(usage, "cost_usd"),
    getObjectNumber(usage, "costUsd"),
    getObjectNumber(hiddenParams, "response_cost"),
    getObjectNumber(privateHiddenParams, "response_cost")
  );
}

function extractResponseHeaderCostUsd(responseHeaders: Record<string, string> | undefined): number | undefined {
  if (!responseHeaders) {
    return undefined;
  }

  for (const [key, value] of Object.entries(responseHeaders)) {
    if (key.toLowerCase() === "x-litellm-response-cost") {
      return parseFiniteNumber(value);
    }
  }

  return undefined;
}

function getObjectNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];

  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }

  if (typeof field === "string" && field.trim().length > 0) {
    return parseFiniteNumber(field);
  }

  return undefined;
}

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function parseFiniteNumber(value: string): number | undefined {
  const parsed = Number(value.trim());

  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstFiniteNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => value !== undefined);
}

function firstPositiveNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => value !== undefined && value > 0);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
