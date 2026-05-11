import { ModelGateway, type ModelGatewayConfig } from "../model/index.js";
import { loadTopchesterConfig, type TopchesterConfig } from "../config/index.js";

export interface AppContext {
  workspaceRoot: string;
  config: TopchesterConfig;
  modelGateway: ModelGateway;
}

export interface CreateAppContextOptions {
  workspaceRoot: string;
  configPath?: string;
}

export function createAppContext(options: CreateAppContextOptions): AppContext {
  const config = loadTopchesterConfig(options);
  const modelGateway = new ModelGateway(normalizeModelGatewayConfig(config));

  return {
    workspaceRoot: options.workspaceRoot,
    config,
    modelGateway,
  };
}

function normalizeModelGatewayConfig(config: TopchesterConfig): ModelGatewayConfig {
  return {
    defaultPurpose: config.models?.defaultPurpose ?? "agent.primary",
    models: config.models?.assignments ?? {},
    providers: config.models?.providers ?? {},
  };
}
