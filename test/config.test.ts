import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppContext } from "../src/app/context.js";
import {
  addGlobalModelChoices,
  addProjectCommandAllowExactRule,
  configureOpenRouterGlobalProvider,
  loadTopchesterConfig,
  setGlobalDefaultModel,
} from "../src/config/index.js";

const envKeys = ["HOME", "TOPCHESTER_CONFIG", "TOPCHESTER_LOG_LEVEL"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), "topchester-home-"));
  delete process.env.TOPCHESTER_CONFIG;
  delete process.env.TOPCHESTER_LOG_LEVEL;
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Topchester config loading", () => {
  it("creates the global config directory when app context starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    process.env.TOPCHESTER_LOG_LEVEL = "silent";
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(workspace, { recursive: true });

    await expect(stat(join(home, ".config", "topchester"))).rejects.toMatchObject({ code: "ENOENT" });

    createAppContext({ workspaceRoot: workspace });

    expect((await stat(join(home, ".config", "topchester"))).isDirectory()).toBe(true);
  });

  it("loads JSONC config files in documented precedence and concatenates list-based policy fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const envConfig = join(root, "env-config.jsonc");
    const cliConfig = join(root, "cli-config.jsonc");
    process.env.HOME = home;
    process.env.TOPCHESTER_CONFIG = envConfig;
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await mkdir(join(workspace, ".topchester"), { recursive: true });

    await writeFile(
      join(home, ".config", "topchester", "config.jsonc"),
      [
        "{",
        '  "models": { "default": "openrouter/openai/gpt-4.1-mini" },',
        '  "ignore": { "paths": ["user/**"] },',
        '  "tools": { "commands": { "allow": ["node scripts/user-check.mjs"], "allowExact": ["node --user"], "deny": ["pnpm publish"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        '  "models": { "default": "openrouter/qwen/qwen3-coder:free", "fast": "openrouter/google/project-fast" },',
        '  "ignore": { "paths": ["project/**"] },',
        '  "tools": { "commands": { "allow": ["node scripts/project-check.mjs"], "allowExact": ["node --project"], "deny": ["npm publish"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, ".topchester", "config.local.jsonc"),
      [
        "{",
        '  "models": { "fast": "openrouter/google/gemini-3.1-flash-lite" },',
        '  "ignore": { "paths": ["local/**"] },',
        '  "tools": { "commands": { "allow": ["node scripts/local-check.mjs"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      envConfig,
      '{ "models": { "kb.summarize": "openrouter/google/gemini-3.1-pro" }, "ignore": { "paths": ["env/**"] }, "tools": { "commands": { "deny": ["yarn publish"] } } }\n'
    );
    await writeFile(
      cliConfig,
      '{ "ignore": { "paths": ["cli/**", "!cli/keep/**"] }, "tools": { "commands": { "allow": ["node scripts/cli-check.mjs"] } } }\n'
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace, configPath: cliConfig });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "openai/gpt-4.1-mini",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "google/project-fast",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "google/gemini-3.1-pro",
      provider: "openrouter",
    });
    expect(config.ignore?.paths).toEqual(["project/**", "user/**", "env/**", "cli/**", "!cli/keep/**"]);
    expect(config.tools?.commands?.allow).toEqual([
      "node scripts/project-check.mjs",
      "node scripts/user-check.mjs",
      "node scripts/cli-check.mjs",
    ]);
    expect(config.tools?.commands?.allowExact).toEqual(["node --project", "node --user"]);
    expect(config.tools?.commands?.deny).toEqual(["npm publish", "pnpm publish", "yarn publish"]);
  });

  it("normalizes provider-qualified model choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "openrouter/qwen/qwen3-coder",
          choices: ["openrouter/qwen/qwen3-coder", "openrouter/anthropic/claude-sonnet-4.5"],
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.choices).toEqual([
      { provider: "openrouter", name: "qwen/qwen3-coder" },
      { provider: "openrouter", name: "anthropic/claude-sonnet-4.5" },
    ]);
  });

  it("rejects bare model choices because /model choices must name a provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = join(workspace, "topchester.jsonc");
    await writeFile(configPath, JSON.stringify({ models: { choices: ["qwen3-coder"] } }));

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace })).toThrow("models.choices.0.provider");
  });

  it("writes OpenRouter provider setup and model choices to global user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    await mkdir(workspace, { recursive: true });

    await expect(configureOpenRouterGlobalProvider()).resolves.toMatchObject({
      path: join(home, ".config", "topchester", "config.jsonc"),
    });
    await addGlobalModelChoices(["openrouter/qwen/qwen3-coder"]);
    await setGlobalDefaultModel("openrouter/anthropic/claude-sonnet-4.5");

    const config = loadTopchesterConfig({ workspaceRoot: workspace });
    const written = await readFile(join(home, ".config", "topchester", "config.jsonc"), "utf8");

    expect(config.models?.providers?.default).toBe("openrouter");
    expect(config.models?.providers?.openrouter).toMatchObject({
      type: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-sonnet-4.5",
    });
    expect(config.models?.choices).toEqual([
      { provider: "openrouter", name: "anthropic/claude-sonnet-4.5" },
      { provider: "openrouter", name: "qwen/qwen3-coder" },
    ]);
    expect(written).toContain('"OPENROUTER_API_KEY"');
  });

  it("moves the selected global model choice to the top", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    await mkdir(workspace, { recursive: true });

    await addGlobalModelChoices([
      "openrouter/qwen/qwen3-coder",
      "openrouter/anthropic/claude-sonnet-4.5",
      "openrouter/google/gemini-3.1-flash-lite",
    ]);
    await setGlobalDefaultModel("openrouter/google/gemini-3.1-flash-lite");

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.choices?.map((choice) => `${choice.provider}/${choice.name}`)).toEqual([
      "openrouter/google/gemini-3.1-flash-lite",
      "openrouter/qwen/qwen3-coder",
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
  });

  it("can promote starter model choices ahead of older global choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    await mkdir(workspace, { recursive: true });

    await addGlobalModelChoices([
      "openrouter/qwen/qwen3-coder-next",
      "openrouter/qwen/qwen3-coder",
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
    await addGlobalModelChoices(
      ["openrouter/qwen/qwen3-coder:free", "openrouter/qwen/qwen3-coder", "openrouter/google/gemini-3.1-flash-lite"],
      { prioritize: true }
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.choices?.map((choice) => `${choice.provider}/${choice.name}`)).toEqual([
      "openrouter/qwen/qwen3-coder:free",
      "openrouter/qwen/qwen3-coder",
      "openrouter/google/gemini-3.1-flash-lite",
      "openrouter/qwen/qwen3-coder-next",
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
  });

  it("adds repo-scoped command approvals to topchester.jsonc", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    const configPath = join(workspace, "topchester.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        ignore: { paths: ["generated/**"] },
        tools: { commands: { allow: ["node scripts/check-fixtures.mjs"], deny: ["pnpm publish"] } },
      })
    );

    await expect(addProjectCommandAllowExactRule(workspace, "node --version")).resolves.toMatchObject({
      path: configPath,
      added: true,
      allowExact: ["node --version"],
    });

    const config = loadTopchesterConfig({ workspaceRoot: workspace });
    const written = await readFile(configPath, "utf8");

    expect(config.tools?.commands?.allow).toEqual(["node scripts/check-fixtures.mjs"]);
    expect(config.tools?.commands?.allowExact).toEqual(["node --version"]);
    expect(config.tools?.commands?.deny).toEqual(["pnpm publish"]);
    expect(written).toContain('"node --version"');
  });

  it("creates topchester.jsonc for repo-scoped command approvals when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    await expect(addProjectCommandAllowExactRule(workspace, "node --version")).resolves.toMatchObject({
      path: join(workspace, "topchester.jsonc"),
      added: true,
      allowExact: ["node --version"],
    });

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.tools?.commands?.allowExact).toEqual(["node --version"]);
  });

  it("rejects command policy rules that look like shell syntax or globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      '{ "tools": { "commands": { "allow": ["node scripts/*.mjs"] } } }\n'
    );

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace })).toThrow(
      "Command policy rule must be a simple command prefix"
    );
  });

  it("keeps YAML config files as compatibility aliases while preferring JSONC in the same layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(workspace, { recursive: true });

    await writeFile(join(workspace, "topchester.yaml"), ["models:", "  default: openrouter/yaml/model"].join("\n"));
    await writeFile(join(workspace, "topchester.jsonc"), '{ "models": { "default": "openrouter/jsonc/model" } }\n');

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]?.name).toBe("jsonc/model");
  });

  it("expands a simple OpenRouter default model into the primary and fallback slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      ["models:", "  default: openrouter/google/gemini-3.1-flash-lite"].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.defaultPurpose).toBeUndefined();
    expect(config.models?.assignments).toMatchObject({
      "agent.primary": { name: "google/gemini-3.1-flash-lite", provider: "openrouter" },
      "fallback": { name: "google/gemini-3.1-flash-lite", provider: "openrouter" },
    });
    expect(config.models?.assignments?.["agent.fast"]).toBeUndefined();
    expect(config.models?.assignments?.["kb.summarize"]).toBeUndefined();
    expect(config.models?.providers?.default).toBe("openrouter");
    expect(config.models?.providers?.openrouter).toMatchObject({
      type: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      supportsStructuredOutputs: true,
    });
  });

  it("supports the three public model slots: default, fast, and kb.summarize", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: openrouter/anthropic/claude-sonnet-4.5",
        "  fast: openrouter/google/gemini-3.1-flash-lite",
        "  kb.summarize: openrouter/google/gemini-3.1-pro",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "anthropic/claude-sonnet-4.5",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "google/gemini-3.1-flash-lite",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "google/gemini-3.1-pro",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.fallback).toEqual({
      name: "anthropic/claude-sonnet-4.5",
      provider: "openrouter",
    });
  });

  it("supports object model refs for per-slot tool protocol overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: openrouter/openai/gpt-4.1-mini",
        "  fast:",
        "    name: google/gemini-3.1-flash-lite",
        "    provider: openrouter",
        "    toolProtocol: native",
        "  kb.summarize:",
        "    name: google/gemini-3.1-pro",
        "    provider: openrouter",
        "    toolProtocol: text-json",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "google/gemini-3.1-flash-lite",
      provider: "openrouter",
      toolProtocol: "native",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "google/gemini-3.1-pro",
      provider: "openrouter",
      toolProtocol: "text-json",
    });
  });

  it("supports a tiny default model when the provider is configured separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: gpt-4.1-mini",
        "  providers:",
        "    default: openrouter",
        "    openrouter:",
        "      type: openai-compatible",
        "      baseURL: https://openrouter.ai/api/v1",
        "      apiKeyEnv: CUSTOM_OPENROUTER_KEY",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "gpt-4.1-mini",
      provider: "openrouter",
    });
    expect(config.models?.providers?.default).toBe("openrouter");
    expect(config.models?.providers?.openrouter).toMatchObject({
      apiKeyEnv: "CUSTOM_OPENROUTER_KEY",
    });
  });

  it("keeps provider-qualified model ids intact when a default provider is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: qwen/qwen3-coder:free",
        "  fast: openrouter/google/gemini-3.1-flash-lite",
        "  providers:",
        "    default: openrouter",
        "    openrouter:",
        "      type: openai-compatible",
        "      baseURL: https://openrouter.ai/api/v1",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "qwen/qwen3-coder:free",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "google/gemini-3.1-flash-lite",
      provider: "openrouter",
    });
  });

  it("keeps a bare default model bare when no provider is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "topchester.yaml"), ["models:", "  default: local-model"].join("\n"));

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({ name: "local-model" });
    expect(config.models?.providers?.default).toBeUndefined();
    expect(config.models?.providers?.openrouter).toBeUndefined();
  });

  it("lets the user default model replace a project default model", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(home, ".config", "topchester", "config.yaml"),
      ["models:", "  default: openrouter/openai/gpt-4.1-mini"].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.yaml"),
      ["models:", "  default: openrouter/qwen/qwen3-coder:free"].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "openai/gpt-4.1-mini",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.fallback).toEqual({
      name: "openai/gpt-4.1-mini",
      provider: "openrouter",
    });
  });

  it("keeps project fast and kb.summarize slots when user config sets a default", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(home, ".config", "topchester", "config.yaml"),
      ["models:", "  default: openrouter/openai/gpt-4.1-mini"].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  fast: openrouter/google/gemini-3.1-flash-lite",
        "  kb.summarize: openrouter/google/gemini-3.1-pro",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "openai/gpt-4.1-mini",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "google/gemini-3.1-flash-lite",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "google/gemini-3.1-pro",
      provider: "openrouter",
    });
  });

  it("adds attribution defaults to explicitly configured OpenRouter providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: openrouter/google/gemini-3.1-flash-lite",
        "  providers:",
        "    openrouter:",
        "      type: openai-compatible",
        "      baseURL: https://custom-openrouter.example/v1",
        "      apiKeyEnv: CUSTOM_OPENROUTER_KEY",
        "      supportsStructuredOutputs: false",
        "      service_tier: flex",
        "      toolProtocol: native",
        "      openRouterToolRouting: off",
        "      headers:",
        "        X-Test: custom",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.providers?.openrouter).toEqual({
      type: "openai-compatible",
      baseURL: "https://custom-openrouter.example/v1",
      apiKeyEnv: "CUSTOM_OPENROUTER_KEY",
      supportsStructuredOutputs: false,
      service_tier: "flex",
      toolProtocol: "native",
      openRouterToolRouting: "off",
      headers: {
        "HTTP-Referer": "https://topchester.com",
        "X-Title": "Topchester",
        "X-Test": "custom",
      },
    });
  });

  it("preserves explicit OpenRouter attribution header overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default: openrouter/google/gemini-3.1-flash-lite",
        "  providers:",
        "    openrouter:",
        "      type: openai-compatible",
        "      baseURL: https://openrouter.ai/api/v1",
        "      apiKeyEnv: OPENROUTER_API_KEY",
        "      headers:",
        "        HTTP-Referer: https://example.com",
        "        X-Title: Custom App",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.providers?.openrouter).toMatchObject({
      headers: {
        "HTTP-Referer": "https://example.com",
        "X-Title": "Custom App",
      },
    });
  });

  it("infers native OpenAI tool defaults for OpenAI-compatible providers named openai", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default:",
        "    name: gpt-5.5(low)",
        "    provider: openai",
        "  providers:",
        "    default: openai",
        "    openai:",
        "      type: openai-compatible",
        "      baseURL: http://localhost:8317/v1",
        "      apiKey: dummy-not-used",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.providers?.openai).toMatchObject({
      type: "openai-compatible",
      baseURL: "http://localhost:8317/v1",
      apiKey: "dummy-not-used",
      supportsStructuredOutputs: true,
      toolProtocol: "native",
    });
  });

  it("preserves explicit OpenAI-compatible provider capability overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default:",
        "    name: gpt-5.5(low)",
        "    provider: openai",
        "  providers:",
        "    openai:",
        "      type: openai-compatible",
        "      baseURL: https://api.openai.com/v1",
        "      apiKeyEnv: OPENAI_API_KEY",
        "      supportsStructuredOutputs: false",
        "      toolProtocol: auto",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.providers?.openai).toMatchObject({
      supportsStructuredOutputs: false,
      toolProtocol: "auto",
    });
  });

  it("supports a full config with all public model and provider options", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.yaml"),
      [
        "models:",
        "  default:",
        "    name: anthropic/claude-sonnet-4.5",
        "    provider: openrouter",
        "    toolProtocol: auto",
        "  fast:",
        "    name: openai/gpt-4.1-mini",
        "    provider: openrouter",
        "    toolProtocol: native",
        "  kb.summarize:",
        "    name: qwen2.5-coder:14b",
        "    provider: ollama",
        "    toolProtocol: text-json",
        "  providers:",
        "    default: openrouter",
        "    openrouter:",
        "      type: openai-compatible",
        "      baseURL: https://openrouter.ai/api/v1",
        "      apiKeyEnv: OPENROUTER_API_KEY",
        "      supportsStructuredOutputs: true",
        "      service_tier: flex",
        "      toolProtocol: auto",
        "      openRouterToolRouting: force",
        "      headers:",
        "        X-Test: custom",
        "    ollama:",
        "      type: openai-compatible",
        "      baseURL: http://localhost:11434/v1",
        "      apiKey: ollama",
        "      supportsStructuredOutputs: false",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "anthropic/claude-sonnet-4.5",
      provider: "openrouter",
      toolProtocol: "auto",
    });
    expect(config.models?.assignments?.["agent.fast"]).toEqual({
      name: "openai/gpt-4.1-mini",
      provider: "openrouter",
      toolProtocol: "native",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "qwen2.5-coder:14b",
      provider: "ollama",
      toolProtocol: "text-json",
    });
    expect(config.models?.providers?.openrouter).toMatchObject({
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      service_tier: "flex",
      toolProtocol: "auto",
      openRouterToolRouting: "force",
      headers: {
        "HTTP-Referer": "https://topchester.com",
        "X-Title": "Topchester",
        "X-Test": "custom",
      },
    });
    expect(config.models?.providers?.ollama).toMatchObject({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  });

  it("accepts JSONC shorthand config and normalizes it like YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        '  "models": {',
        '    "default": "openrouter/google/gemini-3.1-flash-lite",',
        '    "kb.summarize": "openrouter/google/gemini-3.1-pro"',
        "  }",
        "}",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "google/gemini-3.1-flash-lite",
      provider: "openrouter",
    });
    expect(config.models?.assignments?.["kb.summarize"]).toEqual({
      name: "google/gemini-3.1-pro",
      provider: "openrouter",
    });
  });

  it("rejects old assignment config and malformed model refs with clear paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const invalidDefault = join(workspace, "invalid-default.yaml");
    const invalidOldAssignments = join(workspace, "invalid-old-assignments.yaml");
    const invalidDefaultPurpose = join(workspace, "invalid-default-purpose.yaml");
    await writeFile(invalidDefault, ["models:", "  default:", "    label: nope"].join("\n"));
    await writeFile(
      invalidOldAssignments,
      ["models:", "  assignments:", "    kb.summarize: openrouter/model"].join("\n")
    );
    await writeFile(invalidDefaultPurpose, ["models:", "  defaultPurpose: agent.fast"].join("\n"));

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidDefault })).toThrow(
      `Invalid Topchester config at ${invalidDefault}: models.default: Invalid input`
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidOldAssignments })).toThrow(
      `Invalid Topchester config at ${invalidOldAssignments}: models: Unrecognized key: "assignments"`
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidDefaultPurpose })).toThrow(
      `Invalid Topchester config at ${invalidDefaultPurpose}: models: Unrecognized key: "defaultPurpose"`
    );
  });

  it("reports the config path for invalid JSONC and schema errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const invalidJsonc = join(workspace, "invalid.jsonc");
    const invalidSchema = join(workspace, "invalid-schema.jsonc");
    await writeFile(invalidJsonc, "{\n");
    await writeFile(invalidSchema, '{ "ignore": { "paths": ["/absolute"] } }\n');

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidJsonc })).toThrow(
      `Invalid Topchester config at ${invalidJsonc}:`
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidSchema })).toThrow(
      `Invalid Topchester config at ${invalidSchema}: ignore.paths.0: Ignore path rule must be workspace-relative.`
    );
  });

  it("loads optional advanced provider tool protocol overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    const configPath = join(workspace, "topchester.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          default: { name: "debug-model", provider: "openrouter", toolProtocol: "native" },
          providers: {
            default: "openrouter",
            openrouter: {
              type: "openai-compatible",
              baseURL: "https://openrouter.ai/api/v1",
              apiKey: "test",
              toolProtocol: "text-json",
              openRouterToolRouting: "force",
            },
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]?.toolProtocol).toBe("native");
    expect(config.models?.providers?.openrouter).toMatchObject({
      toolProtocol: "text-json",
      openRouterToolRouting: "force",
    });
  });
});
