import { ModelGateway, type ModelGatewayConfig } from "../model/index.js";
import { loadTopchesterConfig, type TopchesterConfig } from "../config/index.js";

export interface AppContext {
  workspaceRoot: string;
  config: TopchesterConfig;
  modelGateway: ModelGateway;
  devFlags: Set<string>;
}

export interface CreateAppContextOptions {
  workspaceRoot: string;
  configPath?: string;
  devFlags?: string[];
}

export function createAppContext(options: CreateAppContextOptions): AppContext {
  const config = loadTopchesterConfig(options);
  const modelGateway = new ModelGateway(normalizeModelGatewayConfig(config));

  return {
    workspaceRoot: options.workspaceRoot,
    config,
    modelGateway,
    devFlags: new Set(options.devFlags ?? []),
  };
}

function normalizeModelGatewayConfig(config: TopchesterConfig): ModelGatewayConfig {
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
