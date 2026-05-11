import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

const providerSchema = z.object({
  type: z.literal("openai-compatible"),
  baseURL: z.string().url(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  supportsStructuredOutputs: z.boolean().optional(),
});

export const topchesterConfigSchema = z.object({
  models: z
    .object({
      defaultPurpose: modelPurposeSchema.optional(),
      assignments: z.partialRecord(modelPurposeSchema, z.string()).optional(),
      providers: z.record(z.string(), providerSchema).optional(),
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
    join(options.workspaceRoot, "topchester.yaml"),
    join(options.workspaceRoot, ".topchester/config.local.yaml"),
    process.env.TOPCHESTER_CONFIG,
    options.configPath,
  ].filter((path): path is string => Boolean(path));

  let merged: TopchesterConfig = {};

  for (const path of paths) {
    const resolvedPath = isAbsolute(path) ? path : resolve(options.workspaceRoot, path);

    if (!existsSync(resolvedPath)) {
      continue;
    }

    const parsed = parseYaml(readFileSync(resolvedPath, "utf8")) as unknown;
    merged = deepMerge(merged, topchesterConfigSchema.parse(parsed));
  }

  return topchesterConfigSchema.parse(merged);
}

function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }

  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
