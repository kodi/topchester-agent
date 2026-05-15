import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import { toAiSdkToolSet } from "../agent/tools/ai-sdk-tools.js";
import { parseNativeToolCall, parseToolCallWithSource } from "../agent/tools/parser.js";
import {
  type ModelToolCall,
  type ToolDefinition,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
} from "../agent/tools/types.js";

export type ModelPurpose = "agent.primary" | "agent.fast" | "kb.scan" | "kb.summarize" | "fallback";

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  supportsStructuredOutputs?: boolean;
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
    const result = await generateText({
      model: resolved.model,
      system: request.system,
      prompt: request.prompt,
      abortSignal: request.abortSignal,
    });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
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
        const result = await this.generateNativeAgentStep(request, resolved, attempts);

        if (result.toolCalls.length > 0) {
          return result;
        }

        const parsedTextCall = parseToolCallWithSource(result.text);

        if (parsedTextCall) {
          const fallbackProtocol = parsedTextCall.source === "text-xml" ? "text-xml" : "text-json";
          const fallbackReason = "native response contained a text tool call";
          attempts.push({ protocol: fallbackProtocol, status: "fallback", reason: fallbackReason });

          return {
            ...result,
            toolCalls: [
              {
                id: `${parsedTextCall.source}-0`,
                tool: parsedTextCall.call.tool,
                args: parsedTextCall.call.args,
                source: parsedTextCall.source,
              } as ModelToolCall,
            ],
            toolProtocol: fallbackProtocol,
            fallbackReason,
          };
        }

        return result;
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
      system: request.system,
      prompt: request.prompt,
      abortSignal: request.abortSignal,
    });

    yield* result.textStream;
  }

  private async generateNativeAgentStep(
    request: ModelAgentRequest,
    resolved: ReturnType<ModelGateway["resolveModel"]>,
    attempts: ToolProtocolAttempt[]
  ): Promise<ModelAgentResult> {
    const providerOptions = buildNativeProviderOptions(resolved.providerId, resolved.providerConfig);
    const openRouterRoutingApplied = hasOpenRouterRoutingOptions(providerOptions, resolved.providerId);
    const result = request.onReasoning
      ? await this.streamNativeAgentStep(request, resolved, providerOptions)
      : await generateText({
          model: resolved.model,
          system: request.system,
          prompt: request.prompt,
          tools: toAiSdkToolSet(request.tools),
          toolChoice: "auto",
          providerOptions,
          abortSignal: request.abortSignal,
        });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
    });
    const toolCalls = result.toolCalls.map((call, index) => {
      const parsed = parseNativeToolCall(call.toolName, call.input);

      if (!parsed) {
        throw new Error(`Native tool call for ${call.toolName} did not match the registered schema.`);
      }

      return {
        id: call.toolCallId || `native-${index}`,
        tool: parsed.tool,
        args: parsed.args,
        source: "native",
      } as ModelToolCall;
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
          system: request.system,
          prompt: request.prompt,
          abortSignal: request.abortSignal,
        });
    const usage = normalizeUsage(result.usage, {
      providerId: resolved.providerId,
      providerConfig: resolved.providerConfig,
      responseBody: result.response.body,
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
    providerOptions: ProviderOptions
  ) {
    const result = streamText({
      model: resolved.model,
      system: request.system,
      prompt: request.prompt,
      tools: toAiSdkToolSet(request.tools),
      toolChoice: "auto",
      providerOptions,
      abortSignal: request.abortSignal,
      includeRawChunks: true,
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
      system: request.system,
      prompt: request.prompt,
      abortSignal: request.abortSignal,
      includeRawChunks: true,
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

    if (typedPart.type === "raw" && hasUsageCostBody(typedPart.rawValue)) {
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

function hasUsageCostBody(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "usage" in value &&
    (value as { usage?: unknown }).usage &&
    typeof (value as { usage?: unknown }).usage === "object"
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

function buildNativeProviderOptions(providerId: string, config: OpenAICompatibleProviderConfig): ProviderOptions {
  const options: { [key: string]: JsonValue } = {
    parallel_tool_calls: false,
  };

  if (shouldApplyOpenRouterRoutingOptions(providerId, config)) {
    options.provider = { require_parameters: true };
  }

  return {
    [providerId]: options,
  };
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
  }
): ModelTokenUsage | undefined {
  const costUsd =
    context && isOpenRouterProvider(context.providerId, context.providerConfig)
      ? extractOpenRouterCost(context.responseBody)
      : undefined;

  if (!usage) {
    return costUsd === undefined ? undefined : { costUsd };
  }

  const normalized: ModelTokenUsage = {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractOpenRouterCost(responseBody: unknown): number | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }

  const usage = (responseBody as { usage?: unknown }).usage;

  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const cost = (usage as { cost?: unknown }).cost;

  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
