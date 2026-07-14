import { z } from "zod";
import {
  modelChoiceAssignmentSchema,
  reasoningEffortSchema,
  topchesterConfigSchema,
  type ModelChoiceConfig,
  type ReasoningEffort,
  type TopchesterConfig,
} from "./index.js";

export const runtimeConfigOverridesSchema = z.object({
  activeModel: modelChoiceAssignmentSchema.optional(),
  reasoningEffortByProvider: z.record(z.string().min(1), reasoningEffortSchema).default({}),
});

export interface RuntimeConfigOverrides {
  activeModel?: ModelChoiceConfig;
  reasoningEffortByProvider: Record<string, ReasoningEffort>;
}

export interface ValidatedRuntimeConfigOverrides {
  overrides: RuntimeConfigOverrides;
  warnings: string[];
}

export function emptyRuntimeConfigOverrides(): RuntimeConfigOverrides {
  return { reasoningEffortByProvider: {} };
}

export function cloneRuntimeConfigOverrides(overrides: RuntimeConfigOverrides): RuntimeConfigOverrides {
  return runtimeConfigOverridesSchema.parse(structuredClone(overrides));
}

export function applyRuntimeConfigOverrides(
  baseConfig: TopchesterConfig,
  input: RuntimeConfigOverrides
): TopchesterConfig {
  const overrides = runtimeConfigOverridesSchema.parse(input);
  const config = structuredClone(baseConfig);

  if (overrides.activeModel) {
    requireProvider(config, overrides.activeModel.provider, "model");
    const assignment = { ...overrides.activeModel };
    config.models = {
      ...config.models,
      assignments: {
        ...config.models?.assignments,
        "agent.primary": assignment,
        "fallback": assignment,
      },
    };
  }

  for (const [providerId, effort] of Object.entries(overrides.reasoningEffortByProvider)) {
    const provider = requireProvider(config, providerId, "reasoning effort");
    config.providers = {
      ...config.providers,
      [providerId]: { ...provider, reasoningEffort: effort },
    };
  }

  return topchesterConfigSchema.parse(config);
}

export function validateRuntimeConfigOverrides(
  baseConfig: TopchesterConfig,
  input: RuntimeConfigOverrides
): ValidatedRuntimeConfigOverrides {
  const requested = runtimeConfigOverridesSchema.parse(input);
  const warnings: string[] = [];
  const overrides = emptyRuntimeConfigOverrides();

  if (requested.activeModel) {
    if (hasProvider(baseConfig, requested.activeModel.provider)) {
      overrides.activeModel = { ...requested.activeModel };
    } else {
      warnings.push(`Runtime model provider "${requested.activeModel.provider}" is no longer configured.`);
    }
  }

  for (const [providerId, effort] of Object.entries(requested.reasoningEffortByProvider)) {
    if (hasProvider(baseConfig, providerId)) {
      overrides.reasoningEffortByProvider[providerId] = effort;
    } else {
      warnings.push(`Runtime reasoning provider "${providerId}" is no longer configured.`);
    }
  }

  return { overrides, warnings };
}

function hasProvider(config: TopchesterConfig, providerId: string): boolean {
  const provider = config.providers?.[providerId];
  return typeof provider === "object" && provider !== null;
}

function requireProvider(
  config: TopchesterConfig,
  providerId: string,
  overrideKind: string
): Exclude<NonNullable<TopchesterConfig["providers"]>[string], string> {
  const provider = config.providers?.[providerId];

  if (typeof provider !== "object" || provider === null) {
    throw new Error(`Cannot apply runtime ${overrideKind}: provider "${providerId}" is not configured.`);
  }

  return provider;
}
