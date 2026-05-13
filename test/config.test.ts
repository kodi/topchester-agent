import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTopchesterConfig } from "../src/config/index.js";

const envKeys = ["HOME", "TOPCHESTER_CONFIG"] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

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
  it("loads JSONC config files in documented precedence and concatenates ignore paths", async () => {
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
        '  "models": {',
        '    "assignments": { "agent.primary": { "name": "user-primary" } }',
        "  },",
        '  "ignore": { "paths": ["user/**"] }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      [
        "{",
        '  "models": {',
        '    "assignments": { "kb.summarize": { "name": "project-kb" } }',
        "  },",
        '  "ignore": { "paths": ["project/**"] }',
        "}",
      ].join("\n")
    );
    await writeFile(
      join(workspace, ".topchester", "config.local.jsonc"),
      [
        "{",
        '  "models": {',
        '    "assignments": { "agent.primary": { "name": "local-primary" } }',
        "  },",
        '  "ignore": { "paths": ["local/**"] }',
        "}",
      ].join("\n")
    );
    await writeFile(envConfig, '{ "ignore": { "paths": ["env/**"] } }\n');
    await writeFile(
      cliConfig,
      [
        "{",
        '  "models": { "defaultPurpose": "kb.summarize" },',
        '  "ignore": { "paths": ["cli/**", "!cli/keep/**"] }',
        "}",
      ].join("\n")
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace, configPath: cliConfig });

    expect(config.models?.defaultPurpose).toBe("kb.summarize");
    expect(config.models?.assignments?.["agent.primary"]?.name).toBe("local-primary");
    expect(config.models?.assignments?.["kb.summarize"]?.name).toBe("project-kb");
    expect(config.ignore?.paths).toEqual(["user/**", "project/**", "local/**", "env/**", "cli/**", "!cli/keep/**"]);
  });

  it("keeps YAML config files as compatibility aliases while preferring JSONC in the same layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    process.env.HOME = home;
    delete process.env.TOPCHESTER_CONFIG;
    await mkdir(workspace, { recursive: true });

    await writeFile(
      join(workspace, "topchester.yaml"),
      ["models:", "  assignments:", "    agent.primary:", "      name: yaml-primary"].join("\n")
    );
    await writeFile(
      join(workspace, "topchester.jsonc"),
      '{ "models": { "assignments": { "agent.primary": { "name": "jsonc-primary" } } } }\n'
    );

    const config = loadTopchesterConfig({ workspaceRoot: workspace });

    expect(config.models?.assignments?.["agent.primary"]?.name).toBe("jsonc-primary");
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

  it("loads optional advanced tool protocol overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-config-"));
    const workspace = join(root, "workspace");
    const configPath = join(workspace, "topchester.jsonc");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          assignments: {
            "agent.primary": { name: "debug-model", provider: "openrouter", toolProtocol: "native" },
          },
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
