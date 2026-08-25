import { z } from "zod";
import {
  hasConfiguredOrKnownModelProvider,
  materializeKnownModelProvider,
  modelChoiceAssignmentSchema,
  modelPurposeSchema,
  reasoningEffortSchema,
  topchesterConfigSchema,
  type ModelChoiceConfig,
  type ReasoningEffort,
  type TopchesterConfig,
} from "./index.js";

export const runtimeConfigOverridesSchema = z.object({
  modelOverrides: z.partialRecord(modelPurposeSchema, modelChoiceAssignmentSchema).default({}),
  reasoningEffortByProvider: z.record(z.string().min(1), reasoningEffortSchema).default({}),
});

export interface RuntimeConfigOverrides {
  modelOverrides: Partial<Record<z.infer<typeof modelPurposeSchema>, ModelChoiceConfig>>;
  reasoningEffortByProvider: Record<string, ReasoningEffort>;
}

export interface ValidatedRuntimeConfigOverrides {
  overrides: RuntimeConfigOverrides;
  warnings: string[];
}

export function emptyRuntimeConfigOverrides(): RuntimeConfigOverrides {
  return { modelOverrides: {}, reasoningEffortByProvider: {} };
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

  for (const [purpose, model] of Object.entries(overrides.modelOverrides)) {
    if (!model) continue;
    const configWithProvider = materializeKnownModelProvider(config, model.provider);
    requireProvider(configWithProvider, model.provider, `${purpose} model`);
    const assignment = { ...model };
    configWithProvider.models = {
      ...configWithProvider.models,
      assignments: {
        ...configWithProvider.models?.assignments,
        [purpose]: assignment,
        ...(purpose === "agent.primary" ? { fallback: assignment } : {}),
      },
    };
    Object.assign(config, configWithProvider);
  }

  for (const [providerId, effort] of Object.entries(overrides.reasoningEffortByProvider)) {
    const configWithProvider = materializeKnownModelProvider(config, providerId);
    const provider = requireProvider(configWithProvider, providerId, "reasoning effort");
    Object.assign(config, configWithProvider);
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

  for (const [purpose, model] of Object.entries(requested.modelOverrides)) {
    if (!model) continue;
    if (hasConfiguredOrKnownModelProvider(baseConfig, model.provider)) {
      overrides.modelOverrides[purpose as keyof typeof overrides.modelOverrides] = { ...model };
    } else {
      warnings.push(`Runtime ${purpose} model provider "${model.provider}" is no longer configured.`);
    }
  }

  for (const [providerId, effort] of Object.entries(requested.reasoningEffortByProvider)) {
    if (hasConfiguredOrKnownModelProvider(baseConfig, providerId)) {
      overrides.reasoningEffortByProvider[providerId] = effort;
    } else {
      warnings.push(`Runtime reasoning provider "${providerId}" is no longer configured.`);
    }
  }

  return { overrides, warnings };
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
