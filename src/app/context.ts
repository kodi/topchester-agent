import { ModelGateway, type ModelGatewayConfig, type ModelPurpose } from "../model/index.js";
import {
  ensureGlobalTopchesterConfigFile,
  loadTopchesterConfigFromSpec,
  resolveModelChoice,
  resolveConfigLoadSpec,
  type ConfigLoadSpec,
  type ModelChoiceConfig,
  type ReasoningEffort,
  type TopchesterConfig,
} from "../config/index.js";
import {
  applyRuntimeConfigOverrides,
  cloneRuntimeConfigOverrides,
  emptyRuntimeConfigOverrides,
  validateRuntimeConfigOverrides,
  type RuntimeConfigOverrides,
} from "../config/runtime.js";
import { createTopchesterLogger } from "../logging/index.js";
import { type Logger } from "pino";
import { ContextCapacityRegistry } from "../agent/context/registry.js";

export interface AppContext {
  workspaceRoot: string;
  configLoadSpec: ConfigLoadSpec;
  baseConfig: TopchesterConfig;
  runtimeConfigOverrides: RuntimeConfigOverrides;
  config: TopchesterConfig;
  modelGateway: ModelGateway;
  devFlags: Set<string>;
  logger: Logger;
  logFilePath?: string;
  contextCapacityRegistry?: ContextCapacityRegistry;
}

export interface CreateAppContextOptions {
  workspaceRoot: string;
  configPath?: string;
  envConfigPath?: string;
  devFlags?: string[];
}

export function createAppContext(options: CreateAppContextOptions): AppContext {
  ensureGlobalTopchesterConfigFile();
  const configLoadSpec = resolveConfigLoadSpec(options);
  const baseConfig = loadTopchesterConfigFromSpec(configLoadSpec);
  const runtimeConfigOverrides = emptyRuntimeConfigOverrides();
  const config = applyRuntimeConfigOverrides(baseConfig, runtimeConfigOverrides);
  const modelGateway = createModelGatewayFromConfig(config);
  const loggerInfo = createTopchesterLogger(options.workspaceRoot);

  return {
    workspaceRoot: options.workspaceRoot,
    configLoadSpec,
    baseConfig,
    runtimeConfigOverrides,
    config,
    modelGateway,
    devFlags: new Set(options.devFlags ?? []),
    logger: loggerInfo.logger,
    logFilePath: loggerInfo.logFilePath,
    contextCapacityRegistry: new ContextCapacityRegistry(options.workspaceRoot),
  };
}

export function setRuntimeConfigOverrides(context: AppContext, overrides: RuntimeConfigOverrides): void {
  const nextOverrides = cloneRuntimeConfigOverrides(overrides);
  const nextConfig = applyRuntimeConfigOverrides(context.baseConfig, nextOverrides);
  const nextGateway = createModelGatewayFromConfig(nextConfig);

  context.runtimeConfigOverrides = nextOverrides;
  context.config = nextConfig;
  context.modelGateway = nextGateway;
}

export function restoreRuntimeConfigOverrides(context: AppContext, overrides: RuntimeConfigOverrides): string[] {
  const validated = validateRuntimeConfigOverrides(context.baseConfig, overrides);
  setRuntimeConfigOverrides(context, validated.overrides);
  return validated.warnings;
}

export function setRuntimeActiveModel(context: AppContext, activeModel: ModelChoiceConfig | undefined): void {
  setRuntimeModelOverride(context, "agent.primary", activeModel);
}

export function setRuntimeModelOverride(
  context: AppContext,
  purpose: ModelPurpose,
  model: ModelChoiceConfig | undefined
): void {
  const modelOverrides = { ...context.runtimeConfigOverrides.modelOverrides };
  if (model === undefined) {
    delete modelOverrides[purpose];
  } else {
    modelOverrides[purpose] = model;
  }
  setRuntimeConfigOverrides(context, {
    ...context.runtimeConfigOverrides,
    modelOverrides,
  });
}

export function setRuntimeModelReference(
  context: AppContext,
  modelRef: string,
  purpose: ModelPurpose = "agent.primary"
): void {
  setRuntimeModelOverride(context, purpose, resolveModelChoice(context.baseConfig, modelRef));
}

export function setRuntimeReasoningEffort(
  context: AppContext,
  providerId: string,
  effort: ReasoningEffort | undefined
): void {
  const reasoningEffortByProvider = { ...context.runtimeConfigOverrides.reasoningEffortByProvider };
  if (effort === undefined) {
    delete reasoningEffortByProvider[providerId];
  } else {
    reasoningEffortByProvider[providerId] = effort;
  }
  setRuntimeConfigOverrides(context, { ...context.runtimeConfigOverrides, reasoningEffortByProvider });
}

export function resetRuntimeConfigOverrides(context: AppContext): void {
  setRuntimeConfigOverrides(context, emptyRuntimeConfigOverrides());
}

export function reloadAppBaseConfig(context: AppContext): void {
  const nextBaseConfig = loadTopchesterConfigFromSpec(context.configLoadSpec);
  const nextConfig = applyRuntimeConfigOverrides(nextBaseConfig, context.runtimeConfigOverrides);
  const nextGateway = createModelGatewayFromConfig(nextConfig);

  context.baseConfig = nextBaseConfig;
  context.config = nextConfig;
  context.modelGateway = nextGateway;
}

export function createModelGatewayFromConfig(config: TopchesterConfig): ModelGateway {
  return new ModelGateway(normalizeModelGatewayConfig(config));
}

export function normalizeModelGatewayConfig(config: TopchesterConfig): ModelGatewayConfig {
  const providers = config.providers ?? {};
  const { default: defaultProvider, ...namedProviders } = providers;

  return {
    defaultPurpose: config.models?.defaultPurpose ?? "agent.primary",
    models: config.models?.assignments ?? {},
    defaultProvider: typeof defaultProvider === "string" ? defaultProvider : undefined,
    providers: Object.fromEntries(
      Object.entries(namedProviders).filter((entry): entry is [string, Exclude<(typeof entry)[1], string>] => {
        return typeof entry[1] !== "string";
      })
    ),
  };
}
