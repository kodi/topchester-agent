import { ModelGateway, type ModelGatewayConfig } from "../model/index.js";
import { ensureGlobalTopchesterConfigFile, loadTopchesterConfig, type TopchesterConfig } from "../config/index.js";
import { createTopchesterLogger } from "../logging/index.js";
import { type Logger } from "pino";

export interface AppContext {
  workspaceRoot: string;
  config: TopchesterConfig;
  modelGateway: ModelGateway;
  devFlags: Set<string>;
  logger: Logger;
  logFilePath?: string;
}

export interface CreateAppContextOptions {
  workspaceRoot: string;
  configPath?: string;
  devFlags?: string[];
}

export function createAppContext(options: CreateAppContextOptions): AppContext {
  ensureGlobalTopchesterConfigFile();
  const config = loadTopchesterConfig(options);
  const modelGateway = createModelGatewayFromConfig(config);
  const loggerInfo = createTopchesterLogger(options.workspaceRoot);

  return {
    workspaceRoot: options.workspaceRoot,
    config,
    modelGateway,
    devFlags: new Set(options.devFlags ?? []),
    logger: loggerInfo.logger,
    logFilePath: loggerInfo.logFilePath,
  };
}

export function createModelGatewayFromConfig(config: TopchesterConfig): ModelGateway {
  return new ModelGateway(normalizeModelGatewayConfig(config));
}

export function normalizeModelGatewayConfig(config: TopchesterConfig): ModelGatewayConfig {
  const providers = config.models?.providers ?? {};
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
