import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createAppContext,
  reloadAppBaseConfig,
  resetRuntimeConfigOverrides,
  restoreRuntimeConfigOverrides,
  setRuntimeActiveModel,
  setRuntimeConfigOverrides,
  setRuntimeReasoningEffort,
} from "../src/app/context.js";
import { topchesterConfigSchema } from "../src/config/index.js";
import { applyRuntimeConfigOverrides, emptyRuntimeConfigOverrides } from "../src/config/runtime.js";
import { persistBashApproval } from "../src/tui/shell-helpers.js";

const originalHome = process.env.HOME;
const originalConfig = process.env.TOPCHESTER_CONFIG;
const originalLogLevel = process.env.TOPCHESTER_LOG_LEVEL;

beforeEach(async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), "topchester-runtime-home-"));
  process.env.TOPCHESTER_LOG_LEVEL = "silent";
  delete process.env.TOPCHESTER_CONFIG;
});

afterEach(() => {
  restoreEnv("HOME", originalHome);
  restoreEnv("TOPCHESTER_CONFIG", originalConfig);
  restoreEnv("TOPCHESTER_LOG_LEVEL", originalLogLevel);
});

describe("config runtime overrides", () => {
  it("applies model and provider effort without mutating base config or agent.fast", () => {
    const baseConfig = topchesterConfigSchema.parse({
      models: {
        assignments: {
          "agent.primary": { name: "base", provider: "local" },
          "agent.fast": { name: "fast", provider: "local" },
          "kb.summarize": { name: "summary", provider: "local" },
          "fallback": { name: "base", provider: "local" },
        },
      },
      providers: {
        default: "local",
        local: {
          type: "openai-compatible" as const,
          baseURL: "http://127.0.0.1:8317/v1",
          reasoningEffort: "low" as const,
        },
      },
    });

    const effective = applyRuntimeConfigOverrides(baseConfig, {
      activeModel: { name: "runtime", provider: "local" },
      reasoningEffortByProvider: { local: "high" },
    });

    expect(effective.models?.assignments?.["agent.primary"]).toEqual({ name: "runtime", provider: "local" });
    expect(effective.models?.assignments?.fallback).toEqual({ name: "runtime", provider: "local" });
    expect(effective.models?.assignments?.["agent.fast"]).toEqual({ name: "fast", provider: "local" });
    expect(effective.models?.assignments?.["kb.summarize"]).toEqual({ name: "summary", provider: "local" });
    expect(effective.providers?.local).toMatchObject({ reasoningEffort: "high" });
    expect(baseConfig.models?.assignments?.["agent.primary"]?.name).toBe("base");
    expect(baseConfig.providers?.local).toMatchObject({ reasoningEffort: "low" });
  });

  it("retains a CLI-only provider across reloads and clears to loaded defaults", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-workspace-"));
    const profile = join(workspace, "profile.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      profile,
      JSON.stringify({
        models: {
          "default": "openai/gpt-5.5",
          "fast": "openai/gpt-5.5-mini",
          "kb.summarize": "openai/gpt-5.5-summary",
        },
        providers: {
          openai: {
            type: "openai-compatible",
            baseURL: "http://127.0.0.1:8317/v1",
            reasoningEffort: "low",
          },
        },
      })
    );

    const context = createAppContext({ workspaceRoot: workspace, configPath: profile });
    setRuntimeActiveModel(context, { name: "gpt-5.5-pro", provider: "openai" });
    setRuntimeReasoningEffort(context, "openai", "high");
    reloadAppBaseConfig(context);

    expect(context.configLoadSpec.selectedProfile).toEqual({ source: "cli", path: profile });
    expect(context.config.models?.assignments?.["agent.primary"]?.name).toBe("gpt-5.5-pro");
    expect(context.config.models?.assignments?.["agent.fast"]?.name).toBe("gpt-5.5-mini");
    expect(context.config.providers?.openai).toMatchObject({ reasoningEffort: "high" });
    expect(
      ["agent.primary", "agent.fast", "kb.summarize"].map((purpose) => {
        const resolved = context.modelGateway.resolveModel(purpose as "agent.primary" | "agent.fast" | "kb.summarize");
        return [resolved.modelId, resolved.providerConfig.reasoningEffort];
      })
    ).toEqual([
      ["gpt-5.5-pro", "high"],
      ["gpt-5.5-mini", "high"],
      ["gpt-5.5-summary", "high"],
    ]);

    await persistBashApproval(context, "pnpm test");
    expect(context.baseConfig.tools?.bash?.allowExact).toContain("pnpm test");
    expect(context.config.tools?.bash?.allowExact).toContain("pnpm test");
    expect(context.runtimeConfigOverrides.activeModel?.name).toBe("gpt-5.5-pro");

    setRuntimeReasoningEffort(context, "openai", undefined);
    expect(context.config.providers?.openai).toMatchObject({ reasoningEffort: "low" });
    resetRuntimeConfigOverrides(context);
    expect(context.config.models?.assignments?.["agent.primary"]?.name).toBe("gpt-5.5");
  });

  it("keeps the previous runtime active when a replacement snapshot is invalid", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-atomic-"));
    await writeFile(join(workspace, "topchester.jsonc"), JSON.stringify({ models: { default: "openrouter/base" } }));
    const context = createAppContext({ workspaceRoot: workspace });
    setRuntimeActiveModel(context, { name: "working", provider: "openrouter" });
    const previousConfig = context.config;
    const previousGateway = context.modelGateway;

    expect(() =>
      setRuntimeConfigOverrides(context, {
        activeModel: { name: "broken", provider: "missing" },
        reasoningEffortByProvider: {},
      })
    ).toThrow('provider "missing" is not configured');
    expect(context.config).toBe(previousConfig);
    expect(context.modelGateway).toBe(previousGateway);
    expect(context.runtimeConfigOverrides.activeModel?.name).toBe("working");
  });

  it("drops only invalid restored entries and reports one warning per entry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-runtime-restore-"));
    await writeFile(join(workspace, "topchester.jsonc"), JSON.stringify({ models: { default: "openrouter/base" } }));
    const context = createAppContext({ workspaceRoot: workspace });
    const warnings = restoreRuntimeConfigOverrides(context, {
      activeModel: { name: "gone", provider: "missing-model" },
      reasoningEffortByProvider: { "openrouter": "high", "missing-effort": "low" },
    });

    expect(warnings).toHaveLength(2);
    expect(context.runtimeConfigOverrides).toEqual({ reasoningEffortByProvider: { openrouter: "high" } });
    expect(context.config.providers?.openrouter).toMatchObject({ reasoningEffort: "high" });
  });

  it("creates independent empty override objects", () => {
    const first = emptyRuntimeConfigOverrides();
    first.reasoningEffortByProvider.openrouter = "high";
    expect(emptyRuntimeConfigOverrides()).toEqual({ reasoningEffortByProvider: {} });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
