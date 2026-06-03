import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { z } from "zod";

const modelPurposeSchema = z.enum(["agent.primary", "agent.fast", "kb.summarize", "fallback"]);

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
  includeUsage: z.boolean().optional(),
  promptCaching: z.boolean().optional(),
  toolProtocol: toolProtocolSchema.optional(),
  openRouterToolRouting: z.enum(["auto", "force", "off"]).optional(),
});

const modelAssignmentSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  toolProtocol: toolProtocolSchema.optional(),
});

const modelChoiceAssignmentSchema = modelAssignmentSchema.extend({
  provider: z.string().min(1),
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
    "choices": z.array(modelRefSchema).optional(),
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

const bashPermissionRuleSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const trimmed = value.trim();

    if (trimmed !== value) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must not have leading or trailing whitespace.",
      });
    }

    if (!trimmed) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must name a command.",
      });
      return;
    }

    if (/[\r\n]/u.test(trimmed)) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must be a single line.",
      });
    }
  });

const bashPermissionPolicySchema = z
  .object({
    shell: z.string().min(1).optional(),
    allow: z.array(bashPermissionRuleSchema).optional().default([]),
    allowExact: z.array(bashPermissionRuleSchema).optional().default([]),
    deny: z.array(bashPermissionRuleSchema).optional().default([]),
  })
  .strict();

const instructionFilenameSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value !== value.trim()) {
      context.addIssue({
        code: "custom",
        message: "Instruction filename must not have leading or trailing whitespace.",
      });
    }

    if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
      context.addIssue({
        code: "custom",
        message: "Instruction filename must be a single filename, not a path.",
      });
    }
  });

const instructionsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    files: z.array(instructionFilenameSchema).optional(),
    fallbackFiles: z.array(instructionFilenameSchema).optional(),
    maxBytesPerFile: z.number().int().positive().max(1_000_000).optional(),
    maxTotalBytes: z.number().int().positive().max(5_000_000).optional(),
  })
  .strict();

const mcpCommandSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const trimmed = value.trim();

    if (trimmed !== value) {
      context.addIssue({
        code: "custom",
        message: "MCP stdio command must not have leading or trailing whitespace.",
      });
    }

    if (/[\r\n]/u.test(trimmed)) {
      context.addIssue({
        code: "custom",
        message: "MCP stdio command must be a single line.",
      });
    }
  });

const mcpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio"),
    command: mcpCommandSchema,
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
    enabled: z.boolean().optional().default(true),
    timeoutMs: z.number().int().positive().optional(),
    enabledTools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const mcpConfigSchema = z.record(z.string().min(1), mcpStdioServerConfigSchema);

const rawMcpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio"),
    command: mcpCommandSchema,
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabledTools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const rawMcpConfigSchema = z.record(z.string().min(1), rawMcpStdioServerConfigSchema);

export const hookEventNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "Stop",
] as const;

export type HookEventName = (typeof hookEventNames)[number];

const hookEventAliasMap = {
  TaskStart: "SessionStart",
  TaskAcknowledge: "UserPromptSubmit",
  UserActionRequired: "PermissionRequest",
  TaskComplete: "Stop",
} as const satisfies Record<string, HookEventName>;

const hookTimeoutMsSchema = z.number().int().positive().max(600_000);
const hookMatcherSchema = z.union([z.string().min(1), z.array(z.string().min(1))]).optional();

const commandHookHandlerSchema = z
  .object({
    type: z.literal("command").optional(),
    command: z.string().min(1),
    timeoutMs: hookTimeoutMsSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    matcher: hookMatcherSchema,
  })
  .strict();

const hookHandlerSchema = commandHookHandlerSchema;

const canonicalHooksConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    SessionStart: z.array(hookHandlerSchema).optional(),
    UserPromptSubmit: z.array(hookHandlerSchema).optional(),
    PreToolUse: z.array(hookHandlerSchema).optional(),
    PostToolUse: z.array(hookHandlerSchema).optional(),
    PermissionRequest: z.array(hookHandlerSchema).optional(),
    PreCompact: z.array(hookHandlerSchema).optional(),
    Stop: z.array(hookHandlerSchema).optional(),
  })
  .strict();

const rawHooksConfigSchema = canonicalHooksConfigSchema
  .extend({
    TaskStart: z.array(hookHandlerSchema).optional(),
    TaskAcknowledge: z.array(hookHandlerSchema).optional(),
    UserActionRequired: z.array(hookHandlerSchema).optional(),
    TaskComplete: z.array(hookHandlerSchema).optional(),
  })
  .strict();

export type HookHandlerConfig = z.infer<typeof hookHandlerSchema>;
export type HooksConfig = z.infer<typeof canonicalHooksConfigSchema>;

export const topchesterConfigSchema = z.object({
  models: z
    .object({
      defaultPurpose: modelPurposeSchema.optional(),
      assignments: z.partialRecord(modelPurposeSchema, modelAssignmentSchema).optional(),
      choices: z.array(modelChoiceAssignmentSchema).optional(),
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
      bash: bashPermissionPolicySchema.optional(),
    })
    .strict()
    .optional(),
  mcp: mcpConfigSchema.optional(),
  hooks: canonicalHooksConfigSchema.optional(),
  instructions: instructionsConfigSchema.optional(),
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
      bash: bashPermissionPolicySchema.optional(),
    })
    .strict()
    .optional(),
  mcp: rawMcpConfigSchema.optional(),
  hooks: rawHooksConfigSchema.optional(),
  instructions: instructionsConfigSchema.optional(),
});

const topchesterConfigFileSchema = topchesterConfigSchema.extend({
  mcp: rawMcpConfigSchema.optional(),
});

export type TopchesterConfig = z.infer<typeof topchesterConfigSchema>;
type TopchesterConfigFile = z.infer<typeof topchesterConfigFileSchema>;
export type ModelChoiceConfig = z.infer<typeof modelChoiceAssignmentSchema>;

export interface ConfigLoadOptions {
  workspaceRoot: string;
  configPath?: string;
}

export interface ProjectBashAllowRuleResult {
  path: string;
  added: boolean;
  allowExact: string[];
}

export interface ModelConfigUpdateResult {
  path: string;
  choices: string[];
  defaultModel?: string;
}

export function getGlobalTopchesterConfigDir(): string {
  return join(homedir(), ".config", "topchester");
}

export function ensureGlobalTopchesterConfigDir(): string {
  const dir = getGlobalTopchesterConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureGlobalTopchesterConfigFile(): string {
  const configPath = getGlobalTopchesterConfigPath();

  if (!existsSync(configPath)) {
    ensureGlobalTopchesterConfigDir();
    writeFileSync(configPath, getCommentedStarterConfig(), { mode: 0o600 });
  }

  return configPath;
}

export function loadTopchesterConfig(options: ConfigLoadOptions): TopchesterConfig {
  const globalConfigDir = getGlobalTopchesterConfigDir();
  const paths = [
    join(options.workspaceRoot, "topchester.jsonc"),
    join(globalConfigDir, "config.jsonc"),
    process.env.TOPCHESTER_CONFIG,
    options.configPath,
  ].filter((path): path is string => Boolean(path));

  let merged: TopchesterConfigFile = {};

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

export const openRouterProviderDefaults = {
  type: "openai-compatible" as const,
  baseURL: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  supportsStructuredOutputs: true,
  headers: { ...openRouterAttributionHeaders },
};

export async function configureOpenRouterGlobalProvider(): Promise<ModelConfigUpdateResult> {
  const configPath = getGlobalTopchesterConfigPath();
  const config = readConfigObject(configPath);
  const models = ensurePlainObjectProperty(config, "models");
  const providers = ensurePlainObjectProperty(models, "providers");

  providers.default ??= "openrouter";
  providers.openrouter = {
    ...openRouterProviderDefaults,
    ...(isPlainObject(providers.openrouter) ? providers.openrouter : {}),
  };

  await writeGlobalConfig(configPath, config);

  return {
    path: configPath,
    choices: getRawModelChoices(models),
    defaultModel: typeof models.default === "string" ? models.default : undefined,
  };
}

export async function addGlobalModelChoices(
  choices: string[],
  options: { prioritize?: boolean } = {}
): Promise<ModelConfigUpdateResult> {
  const configPath = getGlobalTopchesterConfigPath();
  const config = readConfigObject(configPath);
  const models = ensurePlainObjectProperty(config, "models");
  const existingChoices = ensureStringArrayProperty(models, "choices");
  const normalizedChoices = choices.map((choice) => choice.trim()).filter((choice) => choice.length > 0);

  if (options.prioritize) {
    const prioritized = new Set(normalizedChoices);
    models.choices = [
      ...normalizedChoices.filter((choice, index) => normalizedChoices.indexOf(choice) === index),
      ...existingChoices.filter((choice) => !prioritized.has(choice)),
    ];
  } else {
    for (const normalizedChoice of normalizedChoices) {
      if (!existingChoices.includes(normalizedChoice)) {
        existingChoices.push(normalizedChoice);
      }
    }
  }

  const updatedChoices = ensureStringArrayProperty(models, "choices");

  await writeGlobalConfig(configPath, config);

  return {
    path: configPath,
    choices: updatedChoices,
    defaultModel: typeof models.default === "string" ? models.default : undefined,
  };
}

export async function setGlobalDefaultModel(modelRef: string): Promise<ModelConfigUpdateResult> {
  const normalizedModelRef = modelRef.trim();
  const configPath = getGlobalTopchesterConfigPath();
  const config = readConfigObject(configPath);
  const models = ensurePlainObjectProperty(config, "models");
  const choices = ensureStringArrayProperty(models, "choices");

  models.choices = [normalizedModelRef, ...choices.filter((choice) => choice !== normalizedModelRef)];

  models.default = normalizedModelRef;
  const updatedChoices = ensureStringArrayProperty(models, "choices");
  await writeGlobalConfig(configPath, config);

  return {
    path: configPath,
    choices: updatedChoices,
    defaultModel: normalizedModelRef,
  };
}

export function formatModelRef(model: { name: string; provider?: string }): string {
  return model.provider ? `${model.provider}/${model.name}` : model.name;
}

export function getConfiguredModelChoices(config: TopchesterConfig): ModelChoiceConfig[] {
  const choices = config.models?.choices ?? [];

  if (choices.length > 0) {
    return choices;
  }

  const assignments = Object.values(config.models?.assignments ?? {});
  const seen = new Set<string>();
  const fallbackChoices: ModelChoiceConfig[] = [];

  for (const assignment of assignments) {
    const provider = assignment.provider ?? config.models?.providers?.default;
    if (typeof provider !== "string") {
      continue;
    }

    const choice = { ...assignment, provider };
    const ref = formatModelRef(choice);
    if (seen.has(ref)) {
      continue;
    }

    seen.add(ref);
    fallbackChoices.push(choice);
  }

  return fallbackChoices;
}

export async function addProjectBashAllowExactRule(
  workspaceRoot: string,
  command: string
): Promise<ProjectBashAllowRuleResult> {
  const configPath = join(workspaceRoot, "topchester.jsonc");
  const config = readProjectConfigObject(configPath);
  const tools = ensurePlainObjectProperty(config, "tools");
  const bash = ensurePlainObjectProperty(tools, "bash");
  const allowExact = ensureStringArrayProperty(bash, "allowExact");
  const normalizedCommand = command.trim();
  const added = !allowExact.includes(normalizedCommand);

  if (added) {
    allowExact.push(normalizedCommand);
  }

  parseConfigFile(configPath, config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    path: configPath,
    added,
    allowExact,
  };
}

function readProjectConfigObject(configPath: string): Record<string, unknown> {
  return readConfigObject(configPath);
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return { $schema: "https://topchester.com/schemas/config.v1.json" };
  }

  const parsed = readConfigFile(configPath);

  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Topchester config at ${configPath}: <root>: Expected an object.`);
  }

  return parsed;
}

function getGlobalTopchesterConfigPath(): string {
  return join(getGlobalTopchesterConfigDir(), "config.jsonc");
}

async function writeGlobalConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  ensureGlobalTopchesterConfigDir();
  parseConfigFile(configPath, config);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function ensurePlainObjectProperty(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];

  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Invalid Topchester config property '${key}': expected an object.`);
  }

  return value;
}

function ensureStringArrayProperty(parent: Record<string, unknown>, key: string): string[] {
  const value = parent[key];

  if (value === undefined) {
    const created: string[] = [];
    parent[key] = created;
    return created;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Invalid Topchester config property '${key}': expected a string array.`);
  }

  return value;
}

function readConfigFile(path: string): unknown {
  try {
    return parseJsonc(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Topchester config at ${path}: ${formatErrorMessage(error)}`);
  }
}

function parseJsonc(source: string): unknown {
  const stripped = stripJsoncSyntax(source);
  return stripped.trim() ? JSON.parse(stripped) : {};
}

function getCommentedStarterConfig(): string {
  return [
    "// Uncomment and edit this minimal config to choose a default model.",
    "// {",
    '//   "models": {',
    '//     "default": "openrouter/google/gemini-3.1-flash-lite",',
    "//   },",
    "// }",
    "",
  ].join("\n");
}

function stripJsoncSyntax(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];

    if (inString) {
      output += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        output += " ";
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" || source[index] === "\r" ? source[index]! : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }

    if (char === "," && isTrailingJsonComma(source, index + 1)) {
      output += " ";
      continue;
    }

    output += char;
  }

  return output;
}

function isTrailingJsonComma(source: string, startIndex: number): boolean {
  let index = startIndex;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    return char === "}" || char === "]";
  }

  return false;
}

function parseConfigFile(path: string, value: unknown): TopchesterConfigFile {
  const raw = rawTopchesterConfigSchema.safeParse(value ?? {});

  if (!raw.success) {
    throw new Error(`Invalid Topchester config at ${path}: ${raw.error.issues.map(formatZodIssue).join("; ")}`);
  }

  const parsed = topchesterConfigFileSchema.safeParse(normalizeConfigInput(raw.data));

  if (!parsed.success) {
    throw new Error(`Invalid Topchester config at ${path}: ${parsed.error.issues.map(formatZodIssue).join("; ")}`);
  }

  return parsed.data;
}

function normalizeConfigInput(value: unknown): unknown {
  const normalizedModels = normalizeModelsConfigInput(value);

  return normalizeHooksConfigInput(normalizedModels);
}

function normalizeModelsConfigInput(value: unknown): unknown {
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
  const modelChoices = Array.isArray(models.choices)
    ? models.choices.map((choice) => modelRefToAssignment(normalizeModelRef(choice, undefined) ?? { model: "" }))
    : undefined;

  if (defaultModelRef) {
    const assignment = modelRefToAssignment(defaultModelRef);

    assignments["agent.primary"] = assignment;
    assignments.fallback = assignment;

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

  delete models.choices;
  applyKnownProviderDefaults(providers);

  return {
    ...value,
    models: {
      ...models,
      assignments,
      ...(modelChoices ? { choices: modelChoices } : {}),
      providers,
    },
  };
}

function normalizeHooksConfigInput(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.hooks)) {
    return value;
  }

  const hooks: Record<string, unknown> = { ...value.hooks };

  for (const [alias, canonical] of Object.entries(hookEventAliasMap)) {
    const aliasHandlers = hooks[alias];

    if (aliasHandlers === undefined) {
      continue;
    }

    const canonicalHandlers = hooks[canonical];

    if (!Array.isArray(aliasHandlers) || (canonicalHandlers !== undefined && !Array.isArray(canonicalHandlers))) {
      continue;
    }

    hooks[canonical] = [...(canonicalHandlers ?? []), ...aliasHandlers];
    delete hooks[alias];
  }

  return { ...value, hooks };
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

  providers.openrouter = { ...openRouterProviderDefaults };
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
      joinedPath === "ignore.paths" ||
      joinedPath === "tools.bash.allow" ||
      joinedPath === "tools.bash.allowExact" ||
      joinedPath === "tools.bash.deny" ||
      (path.length === 2 && path[0] === "hooks" && hookEventNames.includes(path[1] as HookEventName))
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

function getRawModelChoices(models: Record<string, unknown>): string[] {
  const choices = models.choices;

  return Array.isArray(choices) ? choices.filter((choice): choice is string => typeof choice === "string") : [];
}

function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
