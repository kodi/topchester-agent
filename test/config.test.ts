import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppContext } from "../src/app/context.js";
import {
  addGlobalModelChoices,
  addProjectBashAllowExactRule,
  configureCodexGlobalProvider,
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

  it("creates a commented starter global config file when app context starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const configPath = join(home, ".config", "topchester", "config.jsonc");
    process.env.HOME = home;
    process.env.TOPCHESTER_LOG_LEVEL = "silent";
    await mkdir(workspace, { recursive: true });

    createAppContext({ workspaceRoot: workspace });

    const written = await readFile(configPath, "utf8");
    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(written).toContain('//   "models": {');
    expect(written).toContain('//     "default": "openrouter/google/gemini-3.1-flash-lite",');
    expect(config.models).toBeUndefined();
  });

  it("does not overwrite an existing global config file when app context starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const configPath = join(home, ".config", "topchester", "config.jsonc");
    process.env.HOME = home;
    process.env.TOPCHESTER_LOG_LEVEL = "silent";
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await writeFile(configPath, '{ "models": { "default": "openrouter/qwen/qwen3-coder:free" } }\n');

    createAppContext({ workspaceRoot: workspace });

    expect(await readFile(configPath, "utf8")).toBe(
      '{ "models": { "default": "openrouter/qwen/qwen3-coder:free" } }\n'
    );
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
        '  "tools": { "bash": { "allow": ["node scripts/user-check.mjs"], "allowExact": ["node --user"], "deny": ["pnpm publish"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        '  "models": { "default": "openrouter/qwen/qwen3-coder:free", "fast": "openrouter/google/project-fast" },',
        '  "ignore": { "paths": ["project/**"] },',
        '  "tools": { "bash": { "allow": ["node scripts/project-check.mjs"], "allowExact": ["node --project"], "deny": ["npm publish"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, ".topchester", "config.local.jsonc"),
      [
        "{",
        '  "models": { "fast": "openrouter/google/gemini-3.1-flash-lite" },',
        '  "ignore": { "paths": ["local/**"] },',
        '  "tools": { "bash": { "allow": ["node scripts/local-check.mjs"] } }',
        "}",
      ].join("\n")
    );
    await writeFile(
      envConfig,
      '{ "models": { "kb.summarize": "openrouter/google/gemini-3.1-pro" }, "ignore": { "paths": ["env/**"] }, "tools": { "bash": { "deny": ["yarn publish"] } } }\n'
    );
    await writeFile(
      cliConfig,
      '{ "ignore": { "paths": ["cli/**", "!cli/keep/**"] }, "tools": { "bash": { "allow": ["node scripts/cli-check.mjs"] } } }\n'
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
    expect(config.tools?.bash?.allow).toEqual([
      "node scripts/project-check.mjs",
      "node scripts/user-check.mjs",
      "node scripts/cli-check.mjs",
    ]);
    expect(config.tools?.bash?.allowExact).toEqual(["node --project", "node --user"]);
    expect(config.tools?.bash?.deny).toEqual(["npm publish", "pnpm publish", "yarn publish"]);
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

  it("normalizes hook aliases and concatenates hook lists across config layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const envConfig = join(root, "env-config.jsonc");
    process.env.HOME = home;
    process.env.TOPCHESTER_CONFIG = envConfig;
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              command: ".topchester/hooks/project-start.sh",
              statusMessage: "Starting project hook",
            },
          ],
          TaskAcknowledge: [{ command: "peon >/dev/null" }],
          UserActionRequired: [{ command: "peon-required >/dev/null" }],
        },
      })
    );
    await writeFile(
      join(home, ".config", "topchester", "config.jsonc"),
      JSON.stringify({
        hooks: {
          TaskStart: [{ command: "topchester-user-start" }],
        },
      })
    );
    await writeFile(
      envConfig,
      JSON.stringify({
        hooks: {
          TaskComplete: [{ command: "peon >/dev/null" }],
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.hooks?.SessionStart).toEqual([
      { command: ".topchester/hooks/project-start.sh", statusMessage: "Starting project hook" },
      { command: "topchester-user-start" },
    ]);
    expect(config.hooks?.UserPromptSubmit).toEqual([{ command: "peon >/dev/null" }]);
    expect(config.hooks?.PermissionRequest).toEqual([{ command: "peon-required >/dev/null" }]);
    expect(config.hooks?.Stop).toEqual([{ command: "peon >/dev/null" }]);
  });

  it("rejects non-command hook handler types", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = join(workspace, "topchester.jsonc");
    await writeFile(configPath, JSON.stringify({ hooks: { Stop: [{ type: "peonPing" }] } }));

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace })).toThrow("hooks.Stop.0");
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

    expect(config.providers?.default).toBe("openrouter");
    expect(config.providers?.openrouter).toMatchObject({
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

  it("writes Codex provider setup and starter model choices to global user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    await mkdir(workspace, { recursive: true });

    await addGlobalModelChoices(["openrouter/qwen/qwen3-coder", "codex/gpt-5.4-mini"]);
    await expect(configureCodexGlobalProvider()).resolves.toMatchObject({
      path: join(home, ".config", "topchester", "config.jsonc"),
      choices: [
        "codex/gpt-5.5",
        "codex/gpt-5.4",
        "codex/gpt-5.4-mini",
        "codex/gpt-5.3-codex-spark",
        "openrouter/qwen/qwen3-coder",
      ],
    });

    const config = loadTopchesterConfig({ workspaceRoot: workspace });
    const written = await readFile(join(home, ".config", "topchester", "config.jsonc"), "utf8");

    expect(config.providers?.default).toBe("codex");
    expect(config.providers?.codex).toEqual({
      type: "openai-compatible",
      baseURL: "https://chatgpt.com/backend-api",
      toolProtocol: "text-json",
    });
    expect(config.models?.choices?.map((choice) => `${choice.provider}/${choice.name}`)).toEqual([
      "codex/gpt-5.5",
      "codex/gpt-5.4",
      "codex/gpt-5.4-mini",
      "codex/gpt-5.3-codex-spark",
      "openrouter/qwen/qwen3-coder",
    ]);
    expect(written).not.toContain("apiKey");
    expect(written).not.toContain("OPENAI_API_KEY");
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

  it("adds repo-scoped bash approvals to topchester.jsonc", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    const configPath = join(workspace, "topchester.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        ignore: { paths: ["generated/**"] },
        tools: { bash: { allow: ["node scripts/check-fixtures.mjs"], deny: ["pnpm publish"] } },
      })
    );

    await expect(addProjectBashAllowExactRule(workspace, "node --version")).resolves.toMatchObject({
      path: configPath,
      added: true,
      allowExact: ["node --version"],
    });

    const config = loadTopchesterConfig({ workspaceRoot: workspace });
    const written = await readFile(configPath, "utf8");

    expect(config.tools?.bash?.allow).toEqual(["node scripts/check-fixtures.mjs"]);
    expect(config.tools?.bash?.allowExact).toEqual(["node --version"]);
    expect(config.tools?.bash?.deny).toEqual(["pnpm publish"]);
    expect(written).toContain('"node --version"');
  });

  it("creates topchester.jsonc for repo-scoped bash approvals when none exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    await expect(addProjectBashAllowExactRule(workspace, "node --version")).resolves.toMatchObject({
      path: join(workspace, "topchester.jsonc"),
      added: true,
      allowExact: ["node --version"],
    });

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.tools?.bash?.allowExact).toEqual(["node --version"]);
  });

  it("allows shell syntax in exact bash permission rules but rejects multiline rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      '{ "tools": { "bash": { "allowExact": ["printf hi | wc -c"] } } }\n'
    );

    expect(loadTopchesterConfig({ workspaceRoot: workspace }).tools?.bash?.allowExact).toEqual(["printf hi | wc -c"]);

    await writeFile(join(workspace, "topchester.jsonc"), '{ "tools": { "bash": { "allow": ["node\\nwhoami"] } } }\n');

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace })).toThrow(
      "Bash permission rule must be a single line"
    );
  });

  it("loads stdio MCP server config and merges per-server objects across layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    await mkdir(join(home, ".config", "topchester"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "stdio",
            command: "node",
            args: ["test/fixtures/mcp/stdio-server.js"],
            env: { FIXTURE_MODE: "project" },
            timeoutMs: 1000,
            enabledTools: ["echo", "sum"],
          },
        },
      })
    );
    await writeFile(
      join(home, ".config", "topchester", "config.jsonc"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "stdio",
            command: "tsx",
            env: { USER_ONLY: "1" },
            enabled: false,
            enabledTools: ["echo"],
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.mcp?.fixture).toEqual({
      type: "stdio",
      command: "tsx",
      args: ["test/fixtures/mcp/stdio-server.js"],
      env: { FIXTURE_MODE: "project", USER_ONLY: "1" },
      enabled: false,
      timeoutMs: 1000,
      enabledTools: ["echo"],
    });
  });

  it("applies stdio MCP server defaults for explicit entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "stdio",
            command: "node",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.mcp?.fixture).toEqual({
      type: "stdio",
      command: "node",
      args: [],
      env: {},
      enabled: true,
    });
  });

  it("rejects invalid MCP stdio config", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const invalidTransport = join(workspace, "invalid-mcp-transport.jsonc");
    const invalidCommand = join(workspace, "invalid-mcp-command.jsonc");
    const invalidTimeout = join(workspace, "invalid-mcp-timeout.jsonc");
    const invalidEnabledTools = join(workspace, "invalid-mcp-enabled-tools.jsonc");
    await writeFile(invalidTransport, '{ "mcp": { "fixture": { "type": "http", "command": "node" } } }\n');
    await writeFile(invalidCommand, '{ "mcp": { "fixture": { "type": "stdio", "command": " node" } } }\n');
    await writeFile(
      invalidTimeout,
      '{ "mcp": { "fixture": { "type": "stdio", "command": "node", "timeoutMs": 0 } } }\n'
    );
    await writeFile(
      invalidEnabledTools,
      '{ "mcp": { "fixture": { "type": "stdio", "command": "node", "enabledTools": [""] } } }\n'
    );

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidTransport })).toThrow(
      `Invalid Topchester config at ${invalidTransport}: mcp.fixture.type: Invalid input: expected "stdio"`
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidCommand })).toThrow(
      "mcp.fixture.command: MCP stdio command must not have leading or trailing whitespace."
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidTimeout })).toThrow(
      "mcp.fixture.timeoutMs: Too small: expected number to be >0"
    );
    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidEnabledTools })).toThrow(
      "mcp.fixture.enabledTools.0: Too small: expected string to have >=1 characters"
    );
  });

  it("ignores YAML config files and only loads JSONC config files", async () => {
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
      join(workspace, "topchester.jsonc"),
      '{ "models": { "default": "openrouter/google/gemini-3.1-flash-lite" } }\n'
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.defaultPurpose).toBeUndefined();
    expect(config.models?.assignments).toMatchObject({
      "agent.primary": { name: "google/gemini-3.1-flash-lite", provider: "openrouter" },
      "fallback": { name: "google/gemini-3.1-flash-lite", provider: "openrouter" },
    });
    expect(config.models?.assignments?.["agent.fast"]).toBeUndefined();
    expect(config.models?.assignments?.["kb.summarize"]).toBeUndefined();
    expect(config.providers?.default).toBe("openrouter");
    expect(config.providers?.openrouter).toMatchObject({
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          "default": "openrouter/anthropic/claude-sonnet-4.5",
          "fast": "openrouter/google/gemini-3.1-flash-lite",
          "kb.summarize": "openrouter/google/gemini-3.1-pro",
        },
      })
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          "default": "openrouter/openai/gpt-4.1-mini",
          "fast": {
            name: "google/gemini-3.1-flash-lite",
            provider: "openrouter",
            toolProtocol: "native",
          },
          "kb.summarize": {
            name: "google/gemini-3.1-pro",
            provider: "openrouter",
            toolProtocol: "text-json",
          },
        },
      })
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "gpt-4.1-mini",
        },
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
            apiKeyEnv: "CUSTOM_OPENROUTER_KEY",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "gpt-4.1-mini",
      provider: "openrouter",
    });
    expect(config.providers?.default).toBe("openrouter");
    expect(config.providers?.openrouter).toMatchObject({
      apiKeyEnv: "CUSTOM_OPENROUTER_KEY",
    });
  });

  it("keeps provider-qualified model ids intact when a default provider is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "qwen/qwen3-coder:free",
          fast: "openrouter/google/gemini-3.1-flash-lite",
        },
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
          },
        },
      })
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

  it("lets an explicit Codex model override an OpenRouter default provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "codex/gpt-5.4-mini",
        },
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
          },
          codex: {
            type: "openai-compatible",
            baseURL: "https://chatgpt.com/backend-api",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      name: "gpt-5.4-mini",
      provider: "codex",
    });
    expect(config.providers?.default).toBe("openrouter");
  });

  it("keeps a bare default model bare when no provider is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "topchester.jsonc"), '{ "models": { "default": "local-model" } }\n');

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]).toEqual({ name: "local-model" });
    expect(config.providers?.default).toBeUndefined();
    expect(config.providers?.openrouter).toBeUndefined();
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
      join(home, ".config", "topchester", "config.jsonc"),
      '{ "models": { "default": "openrouter/openai/gpt-4.1-mini" } }\n'
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      '{ "models": { "default": "openrouter/qwen/qwen3-coder:free" } }\n'
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
      join(home, ".config", "topchester", "config.jsonc"),
      '{ "models": { "default": "openrouter/openai/gpt-4.1-mini" } }\n'
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      '{ "models": { "fast": "openrouter/google/gemini-3.1-flash-lite", "kb.summarize": "openrouter/google/gemini-3.1-pro" } }\n'
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "openrouter/google/gemini-3.1-flash-lite",
        },
        providers: {
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://custom-openrouter.example/v1",
            apiKeyEnv: "CUSTOM_OPENROUTER_KEY",
            supportsStructuredOutputs: false,
            service_tier: "flex",
            toolProtocol: "native",
            openRouterToolRouting: "off",
            headers: { "X-Test": "custom" },
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.openrouter).toEqual({
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

  it("adds known Codex provider defaults for Codex model refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "codex/gpt-5.5",
          choices: ["codex/gpt-5.5", "codex/gpt-5.4-mini"],
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.default).toBe("codex");
    expect(config.providers?.codex).toEqual({
      type: "openai-compatible",
      baseURL: "https://chatgpt.com/backend-api",
      toolProtocol: "text-json",
    });
    expect(config.models?.assignments?.["agent.primary"]).toEqual({
      provider: "codex",
      name: "gpt-5.5",
    });
    expect(config.models?.choices).toEqual([
      { provider: "codex", name: "gpt-5.5" },
      { provider: "codex", name: "gpt-5.4-mini" },
    ]);
  });

  it("preserves explicit Codex provider overrides without adding API-key auth defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "codex/gpt-5.5",
        },
        providers: {
          codex: {
            type: "openai-compatible",
            baseURL: "https://chatgpt.example/backend-api",
            supportsStructuredOutputs: false,
            toolProtocol: "auto",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.codex).toEqual({
      type: "openai-compatible",
      baseURL: "https://chatgpt.example/backend-api",
      supportsStructuredOutputs: false,
      toolProtocol: "auto",
    });
  });

  it("preserves explicit OpenRouter attribution header overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: "openrouter/google/gemini-3.1-flash-lite",
        },
        providers: {
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
            headers: {
              "HTTP-Referer": "https://example.com",
              "X-Title": "Custom App",
            },
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.openrouter).toMatchObject({
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: {
            name: "gpt-5.5(low)",
            provider: "openai",
          },
        },
        providers: {
          default: "openai",
          openai: {
            type: "openai-compatible",
            baseURL: "http://localhost:8317/v1",
            apiKey: "dummy-not-used",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.openai).toMatchObject({
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
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          default: {
            name: "gpt-5.5(low)",
            provider: "openai",
          },
        },
        providers: {
          openai: {
            type: "openai-compatible",
            baseURL: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            supportsStructuredOutputs: false,
            toolProtocol: "auto",
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.providers?.openai).toMatchObject({
      supportsStructuredOutputs: false,
      toolProtocol: "auto",
    });
  });

  it("supports a full config with all public model and provider options", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      JSON.stringify({
        models: {
          "default": {
            name: "anthropic/claude-sonnet-4.5",
            provider: "openrouter",
            toolProtocol: "auto",
          },
          "fast": {
            name: "openai/gpt-4.1-mini",
            provider: "openrouter",
            toolProtocol: "native",
          },
          "kb.summarize": {
            name: "qwen2.5-coder:14b",
            provider: "ollama",
            toolProtocol: "text-json",
          },
        },
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
            supportsStructuredOutputs: true,
            service_tier: "flex",
            toolProtocol: "auto",
            openRouterToolRouting: "force",
            headers: { "X-Test": "custom" },
          },
          ollama: {
            type: "openai-compatible",
            baseURL: "http://localhost:11434/v1",
            apiKey: "ollama",
            supportsStructuredOutputs: false,
          },
        },
      })
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
    expect(config.providers?.openrouter).toMatchObject({
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
    expect(config.providers?.ollama).toMatchObject({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  });

  it("accepts JSONC shorthand config with comments and trailing commas", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        "  // Provider-qualified shorthand keeps config compact.",
        '  "models": {',
        '    "default": "openrouter/google/gemini-3.1-flash-lite",',
        '    "kb.summarize": "openrouter/google/gemini-3.1-pro",',
        "  },",
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
    const invalidDefault = join(workspace, "invalid-default.jsonc");
    const invalidOldAssignments = join(workspace, "invalid-old-assignments.jsonc");
    const invalidDefaultPurpose = join(workspace, "invalid-default-purpose.jsonc");
    await writeFile(invalidDefault, '{ "models": { "default": { "label": "nope" } } }\n');
    await writeFile(invalidOldAssignments, '{ "models": { "assignments": { "kb.summarize": "openrouter/model" } } }\n');
    await writeFile(invalidDefaultPurpose, '{ "models": { "defaultPurpose": "agent.fast" } }\n');

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

  it("loads project instruction config knobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        '  "instructions": {',
        '    "enabled": true,',
        '    "files": ["AGENT.md"],',
        '    "fallbackFiles": ["CLAUDE.md"],',
        '    "maxBytesPerFile": 1024,',
        '    "maxTotalBytes": 2048',
        "  }",
        "}",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.instructions).toEqual({
      enabled: true,
      files: ["AGENT.md"],
      fallbackFiles: ["CLAUDE.md"],
      maxBytesPerFile: 1024,
      maxTotalBytes: 2048,
    });
  });

  it("rejects instruction filenames that are paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    const invalidConfig = join(workspace, "invalid-instructions.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(invalidConfig, '{ "instructions": { "files": ["docs/AGENTS.md"] } }\n');

    expect(() => loadTopchesterConfig({ workspaceRoot: workspace, configPath: invalidConfig })).toThrow(
      `Invalid Topchester config at ${invalidConfig}: instructions.files.0: Instruction filename must be a single filename, not a path.`
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
        },
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: "test",
            toolProtocol: "text-json",
            openRouterToolRouting: "force",
            includeUsage: false,
            promptCaching: false,
          },
        },
      })
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]?.toolProtocol).toBe("native");
    expect(config.providers?.openrouter).toMatchObject({
      toolProtocol: "text-json",
      openRouterToolRouting: "force",
      includeUsage: false,
      promptCaching: false,
    });
  });
});
