import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type LanguageModel } from "ai";

export type ModelPurpose =
  | "agent.primary"
  | "agent.fast"
  | "kb.scan"
  | "kb.summarize"
  | "kb.extract"
  | "kb.embed"
  | "fallback";

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  supportsStructuredOutputs?: boolean;
}

export interface ModelConfig {
  name: string;
  provider?: string;
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
}

export class ModelGateway {
  readonly #config: ModelGatewayConfig;

  constructor(config: ModelGatewayConfig) {
    this.#config = config;
  }

  resolveModel(purpose = this.#config.defaultPurpose): {
    model: LanguageModel;
    providerId: string;
    modelId: string;
    purpose: ModelPurpose;
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

    return {
      text: result.text,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      purpose: resolved.purpose,
    };
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
