import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const modelPurposeSchema = z.enum(["agent.primary", "agent.fast", "kb.scan", "kb.summarize", "fallback"]);

const modelPurposes = modelPurposeSchema.options;
const toolProtocolSchema = z.enum(["auto", "native", "text-json", "text-xml"]);
const openRouterAttributionHeaders = {
  "HTTP-Referer": "https://topchester.com",
  "X-Title": "Topchester",
};

const providerSchema = z.object({
  type: z.literal("openai-compatible"),
  baseURL: z.string().url(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  supportsStructuredOutputs: z.boolean().optional(),
  service_tier: z.enum(["flex", "priority"]).optional(),
  toolProtocol: toolProtocolSchema.optional(),
  openRouterToolRouting: z.enum(["auto", "force", "off"]).optional(),
});

const modelAssignmentSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  toolProtocol: toolProtocolSchema.optional(),
});

const modelRefSchema = z.union([z.string(), modelAssignmentSchema]);

const providersSchema = z
  .object({
    default: z.string().optional(),
  })
  .catchall(providerSchema.or(z.string()));

const rawModelsSchema = z
  .object({
    "default": modelRefSchema.optional(),
    "fast": modelRefSchema.optional(),
    "kb.summarize": modelRefSchema.optional(),
    "providers": providersSchema.optional(),
  })
  .strict();

const ignorePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const pattern = value.startsWith("!") ? value.slice(1) : value;

    if (!pattern) {
      context.addIssue({
        code: "custom",
        message: "Ignore path rule must include a pattern after negation.",
      });
      return;
    }

    if (pattern === ".") {
      context.addIssue({
        code: "custom",
        message: "Ignore path rule must name a path inside the workspace.",
      });
    }

    if (pattern.startsWith("/") || isAbsolute(pattern) || win32.isAbsolute(pattern)) {
      context.addIssue({
        code: "custom",
        message: "Ignore path rule must be workspace-relative.",
      });
    }

    if (pattern.split(/[\\/]/).includes("..")) {
      context.addIssue({
        code: "custom",
        message: "Ignore path rule must stay inside the workspace.",
      });
    }
  });

const commandPatternSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const trimmed = value.trim();

    if (trimmed !== value) {
      context.addIssue({
        code: "custom",
        message: "Command policy rule must not have leading or trailing whitespace.",
      });
    }

    if (!trimmed) {
      context.addIssue({
        code: "custom",
        message: "Command policy rule must name a command prefix.",
      });
      return;
    }

    if (trimmed.startsWith("/") || isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
      context.addIssue({
        code: "custom",
        message: "Command policy rule must start with an executable name, not a path.",
      });
    }

    if (/[<>|&;$`(){}*?[\]\r\n]/u.test(trimmed)) {
      context.addIssue({
        code: "custom",
        message: "Command policy rule must be a simple command prefix, not shell syntax or a glob.",
      });
    }
  });

const commandPolicySchema = z
  .object({
    allow: z.array(commandPatternSchema).optional().default([]),
    deny: z.array(commandPatternSchema).optional().default([]),
  })
  .strict();

export const topchesterConfigSchema = z.object({
  models: z
    .object({
      defaultPurpose: modelPurposeSchema.optional(),
      assignments: z.partialRecord(modelPurposeSchema, modelAssignmentSchema).optional(),
      providers: providersSchema.optional(),
    })
    .strict()
    .optional(),
  ignore: z
    .object({
      paths: z.array(ignorePathSchema).optional(),
    })
    .optional(),
  tools: z
    .object({
      commands: commandPolicySchema.optional(),
    })
    .strict()
    .optional(),
});

const rawTopchesterConfigSchema = z.object({
  models: rawModelsSchema.optional(),
  ignore: z
    .object({
      paths: z.array(ignorePathSchema).optional(),
    })
    .optional(),
  tools: z
    .object({
      commands: commandPolicySchema.optional(),
    })
    .strict()
    .optional(),
});

export type TopchesterConfig = z.infer<typeof topchesterConfigSchema>;

export interface ConfigLoadOptions {
  workspaceRoot: string;
  configPath?: string;
}

export function getGlobalTopchesterConfigDir(): string {
  return join(homedir(), ".config", "topchester");
}

export function ensureGlobalTopchesterConfigDir(): string {
  const dir = getGlobalTopchesterConfigDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadTopchesterConfig(options: ConfigLoadOptions): TopchesterConfig {
  const globalConfigDir = getGlobalTopchesterConfigDir();
  const paths = [
    join(globalConfigDir, "config.yaml"),
    join(globalConfigDir, "config.jsonc"),
    join(options.workspaceRoot, "topchester.yaml"),
    join(options.workspaceRoot, "topchester.jsonc"),
    join(options.workspaceRoot, ".topchester/config.local.yaml"),
    join(options.workspaceRoot, ".topchester/config.local.jsonc"),
    process.env.TOPCHESTER_CONFIG,
    options.configPath,
  ].filter((path): path is string => Boolean(path));

  let merged: TopchesterConfig = {};

  for (const path of paths) {
    const resolvedPath = isAbsolute(path) ? path : resolve(options.workspaceRoot, path);

    if (!existsSync(resolvedPath)) {
      continue;
    }

    const parsed = readConfigFile(resolvedPath);
    merged = deepMerge(merged, parseConfigFile(resolvedPath, parsed));
  }

  return topchesterConfigSchema.parse(merged);
}

function readConfigFile(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid Topchester config at ${path}: ${formatErrorMessage(error)}`);
  }
}

function parseConfigFile(path: string, value: unknown): TopchesterConfig {
  const raw = rawTopchesterConfigSchema.safeParse(value ?? {});

  if (!raw.success) {
    throw new Error(`Invalid Topchester config at ${path}: ${raw.error.issues.map(formatZodIssue).join("; ")}`);
  }

  const parsed = topchesterConfigSchema.safeParse(normalizeConfigInput(raw.data));

  if (!parsed.success) {
    throw new Error(`Invalid Topchester config at ${path}: ${parsed.error.issues.map(formatZodIssue).join("; ")}`);
  }

  return parsed.data;
}

function normalizeConfigInput(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.models)) {
    return value;
  }

  const models = { ...value.models };
  const providers = isPlainObject(models.providers) ? { ...models.providers } : {};
  const assignments: Record<string, z.infer<typeof modelAssignmentSchema>> = {};
  const defaultModelRef = normalizeModelRef(
    models.default,
    typeof providers.default === "string" ? providers.default : undefined
  );
  const defaultProvider = typeof providers.default === "string" ? providers.default : defaultModelRef?.provider;
  const fastModelRef = normalizeModelRef(models.fast, defaultProvider);
  const kbSummarizeModelRef = normalizeModelRef(models["kb.summarize"], defaultProvider);

  if (defaultModelRef) {
    const assignment = modelRefToAssignment(defaultModelRef);

    for (const purpose of modelPurposes) {
      assignments[purpose] ??= assignment;
    }

    providers.default ??= defaultModelRef.provider;
    ensureKnownProvider(providers, defaultModelRef.provider);
    delete models.default;
  }

  if (fastModelRef) {
    assignments["agent.fast"] = modelRefToAssignment(fastModelRef);
    ensureKnownProvider(providers, fastModelRef.provider);
    delete models.fast;
  }

  if (kbSummarizeModelRef) {
    assignments["kb.summarize"] = modelRefToAssignment(kbSummarizeModelRef);
    ensureKnownProvider(providers, kbSummarizeModelRef.provider);
    delete models["kb.summarize"];
  }

  applyKnownProviderDefaults(providers);

  return {
    ...value,
    models: {
      ...models,
      assignments,
      providers,
    },
  };
}

function normalizeModelRef(
  ref: unknown,
  defaultProvider: string | undefined
): { provider?: string; model: string; toolProtocol?: z.infer<typeof toolProtocolSchema> } | undefined {
  if (typeof ref === "string") {
    return parseModelRef(ref, defaultProvider);
  }

  if (!isPlainObject(ref) || typeof ref.name !== "string") {
    return undefined;
  }

  return {
    model: ref.name,
    ...(typeof ref.provider === "string"
      ? { provider: ref.provider }
      : defaultProvider
        ? { provider: defaultProvider }
        : {}),
    ...(typeof ref.toolProtocol === "string" && toolProtocolSchema.safeParse(ref.toolProtocol).success
      ? { toolProtocol: ref.toolProtocol as z.infer<typeof toolProtocolSchema> }
      : {}),
  };
}

function modelRefToAssignment(ref: {
  provider?: string;
  model: string;
  toolProtocol?: z.infer<typeof toolProtocolSchema>;
}): z.infer<typeof modelAssignmentSchema> {
  return {
    name: ref.model,
    ...(ref.provider ? { provider: ref.provider } : {}),
    ...(ref.toolProtocol ? { toolProtocol: ref.toolProtocol } : {}),
  };
}

function parseModelRef(ref: string, defaultProvider: string | undefined): { provider?: string; model: string } {
  if (defaultProvider) {
    const providerPrefix = `${defaultProvider}/`;

    return ref.startsWith(providerPrefix)
      ? { provider: defaultProvider, model: ref.slice(providerPrefix.length) }
      : { provider: defaultProvider, model: ref };
  }

  const [provider, ...modelParts] = ref.split("/");

  if (provider && modelParts.length > 0) {
    return { provider, model: modelParts.join("/") };
  }

  return { model: ref };
}

function ensureKnownProvider(providers: Record<string, unknown>, provider: string | undefined) {
  if (provider !== "openrouter" || providers.openrouter !== undefined) {
    return;
  }

  providers.openrouter = {
    type: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    supportsStructuredOutputs: true,
    headers: { ...openRouterAttributionHeaders },
  };
}

function applyKnownProviderDefaults(providers: Record<string, unknown>) {
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider) || provider.type !== "openai-compatible" || typeof provider.baseURL !== "string") {
      continue;
    }

    if (isOpenAIProvider(providerId, provider.baseURL)) {
      provider.supportsStructuredOutputs ??= true;
      provider.toolProtocol ??= "native";
    }

    if (isOpenRouterProvider(providerId, provider.baseURL)) {
      provider.headers = {
        ...openRouterAttributionHeaders,
        ...(isPlainObject(provider.headers) ? provider.headers : {}),
      };
    }
  }
}

function isOpenRouterProvider(providerId: string, baseURL: string): boolean {
  return providerId.toLowerCase().includes("openrouter") || baseURL.toLowerCase().includes("openrouter.ai");
}

function isOpenAIProvider(providerId: string, baseURL: string): boolean {
  const normalizedProvider = providerId.toLowerCase();
  const normalizedBaseURL = baseURL.toLowerCase();

  return (
    normalizedProvider === "openai" ||
    normalizedProvider === "gpt" ||
    normalizedProvider.includes("openai") ||
    normalizedBaseURL.includes("api.openai.com")
  );
}

function deepMerge<T>(base: T, override: T, path: string[] = []): T {
  if (Array.isArray(base) && Array.isArray(override)) {
    const joinedPath = path.join(".");
    return (
      joinedPath === "ignore.paths" || joinedPath === "tools.commands.allow" || joinedPath === "tools.commands.deny"
        ? [...base, ...override]
        : override
    ) as T;
  }

  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value, [...path, key]) : value;
  }

  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
