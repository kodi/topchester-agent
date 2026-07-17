import { type AppContext } from "../app/context.js";
import { type StartupTranscriptEntry } from "./transcript.js";

export interface StartupTranscriptOptions {
  banner?: string;
}

export function createStartupTranscriptEntry(
  context: AppContext,
  options: StartupTranscriptOptions = {}
): StartupTranscriptEntry {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.providers ?? {};
  const defaultProviderId = typeof providers.default === "string" ? providers.default : undefined;

  return {
    kind: "startup",
    persistence: "session",
    ...(options.banner === undefined ? {} : { banner: options.banner }),
    workspaceRoot: context.workspaceRoot,
    defaultModelPurpose: context.config.models?.defaultPurpose ?? "agent.primary",
    modelAssignments: Object.entries(assignments).map(([purpose, model]) => ({
      purpose,
      name: model.name,
      ...(model.provider === undefined ? {} : { provider: model.provider }),
    })),
    ...(defaultProviderId === undefined ? {} : { defaultProviderId }),
    providers: Object.entries(providers).flatMap(([id, provider]) => {
      if (id === "default" || typeof provider === "string") {
        return [];
      }

      return [
        {
          id,
          type: provider.type,
          baseURL: provider.baseURL,
          auth: provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none",
          ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort }),
        },
      ];
    }),
    ...(getModelSetupHint(context) === undefined ? {} : { setupHint: getModelSetupHint(context) }),
    prompt: "Ask Topchester what you want to change.",
  };
}

export function getModelSetupHint(context: AppContext): string | undefined {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.providers ?? {};
  const hasAssignments = Object.keys(assignments).length > 0;
  const hasProviders = Object.entries(providers).some(([providerId]) => providerId !== "default");

  if (hasAssignments && hasProviders) {
    return undefined;
  }

  return "Model setup: run /connect openrouter, then /model to choose a model. You can also edit topchester.jsonc for shared project choices or ~/.config/topchester/config.jsonc for your own defaults.";
}
