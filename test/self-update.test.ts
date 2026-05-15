import { describe, expect, it } from "vitest";
import {
  createSelfUpdateCommand,
  detectSelfUpdateManager,
  formatSelfUpdateSuccess,
  runSelfUpdate,
} from "../src/cli/self-update.js";

describe("self update", () => {
  it("detects the package manager from npm user agent", () => {
    expect(detectSelfUpdateManager({ env: { npm_config_user_agent: "pnpm/11.0.8 npm/? node/v24" } })).toBe("pnpm");
    expect(detectSelfUpdateManager({ env: { npm_config_user_agent: "bun/1.3.0" } })).toBe("bun");
    expect(detectSelfUpdateManager({ env: { npm_config_user_agent: "npm/11.0.0 node/v24" } })).toBe("npm");
  });

  it("detects the package manager from installed package paths", () => {
    expect(
      detectSelfUpdateManager({
        modulePath:
          "/Users/me/.local/share/pnpm/global/5/.pnpm/topchester-ai@0.14.0/node_modules/topchester-ai/dist/cli.mjs",
        execPath: "/usr/local/bin/node",
        env: {},
      })
    ).toBe("pnpm");
    expect(
      detectSelfUpdateManager({
        modulePath: "/Users/me/.bun/install/global/node_modules/topchester-ai/dist/cli.mjs",
        execPath: "/usr/local/bin/node",
        env: {},
      })
    ).toBe("bun");
    expect(
      detectSelfUpdateManager({
        modulePath: "/Users/me/.nvm/versions/node/v24/lib/node_modules/topchester-ai/dist/cli.mjs",
        execPath: "/usr/local/bin/node",
        env: {},
      })
    ).toBe("npm");
  });

  it("does not guess from source checkout paths", () => {
    expect(
      detectSelfUpdateManager({
        modulePath: "/repo/topchester-agent/src/cli/self-update.ts",
        execPath: "/usr/local/bin/node",
        env: {},
      })
    ).toBeUndefined();
  });

  it("builds the global install command for the detected manager", () => {
    expect(
      createSelfUpdateCommand({
        target: "v0.15.0",
        env: { npm_config_user_agent: "pnpm/11.0.8" },
      })
    ).toMatchObject({
      manager: "pnpm",
      command: "pnpm",
      args: ["install", "-g", "topchester-ai@0.15.0"],
      display: "pnpm install -g topchester-ai@0.15.0",
      target: "0.15.0",
    });
  });

  it("runs the generated command and reports restart guidance", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const command = await runSelfUpdate({
      env: { npm_config_user_agent: "npm/11.0.0" },
      runner: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    });

    expect(calls).toEqual([{ command: "npm", args: ["install", "-g", "topchester-ai@latest"] }]);
    expect(formatSelfUpdateSuccess(command)).toEqual([
      "Updated Topchester with npm install -g topchester-ai@latest.",
      "Restart Topchester to use the new version.",
    ]);
  });

  it("fails when no package manager can be detected", async () => {
    await expect(
      runSelfUpdate({
        modulePath: "/repo/topchester-agent/src/cli/self-update.ts",
        execPath: "/usr/local/bin/node",
        env: {},
        runner: async () => 0,
      })
    ).rejects.toThrow("Could not detect whether Topchester was installed with npm, pnpm, or bun.");
  });
});
