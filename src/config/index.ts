import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const modelPurposeSchema = z.enum([
  "agent.primary",
  "agent.fast",
  "kb.scan",
  "kb.summarize",
  "kb.extract",
  "kb.embed",
  "fallback",
]);

const toolProtocolSchema = z.enum(["auto", "native", "text-json", "text-xml"]);

const providerSchema = z.object({
  type: z.literal("openai-compatible"),
  baseURL: z.string().url(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  supportsStructuredOutputs: z.boolean().optional(),
  toolProtocol: toolProtocolSchema.optional(),
  openRouterToolRouting: z.enum(["auto", "force", "off"]).optional(),
});

const modelAssignmentSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  toolProtocol: toolProtocolSchema.optional(),
});

const providersSchema = z
  .object({
    default: z.string().optional(),
  })
  .catchall(providerSchema.or(z.string()));

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

export const topchesterConfigSchema = z.object({
  models: z
    .object({
      defaultPurpose: modelPurposeSchema.optional(),
      assignments: z.partialRecord(modelPurposeSchema, modelAssignmentSchema).optional(),
      providers: providersSchema.optional(),
    })
    .optional(),
  ignore: z
    .object({
      paths: z.array(ignorePathSchema).optional(),
    })
    .optional(),
});

export type TopchesterConfig = z.infer<typeof topchesterConfigSchema>;

export interface ConfigLoadOptions {
  workspaceRoot: string;
  configPath?: string;
}

export function loadTopchesterConfig(options: ConfigLoadOptions): TopchesterConfig {
  const paths = [
    join(homedir(), ".config/topchester/config.yaml"),
    join(homedir(), ".config/topchester/config.jsonc"),
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
  const parsed = topchesterConfigSchema.safeParse(value ?? {});

  if (!parsed.success) {
    throw new Error(`Invalid Topchester config at ${path}: ${parsed.error.issues.map(formatZodIssue).join("; ")}`);
  }

  return parsed.data;
}

function deepMerge<T>(base: T, override: T, path: string[] = []): T {
  if (Array.isArray(base) && Array.isArray(override)) {
    return (path.join(".") === "ignore.paths" ? [...base, ...override] : override) as T;
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
