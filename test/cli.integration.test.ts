import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src/cli.ts");
const tsxPath = join(process.cwd(), "node_modules/.bin/tsx");

async function runCli(args: string[], cwd: string) {
  return execFileAsync(tsxPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      TOPCHESTER_CONFIG: "",
    },
  });
}

async function makeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "topchester-cli-")));
  const workspace = join(root, "workspace");
  const config = join(root, "config.yaml");

  await writeFile(
    config,
    [
      "models:",
      "  defaultPurpose: agent.primary",
      "  assignments:",
      "    agent.primary:",
      "      name: qwen/qwen3-coder:free",
      "    fallback:",
      "      name: qwen/qwen3-coder:free",
      "  providers:",
      "    default: openrouter",
      "    openrouter:",
      "      type: openai-compatible",
      "      baseURL: https://openrouter.ai/api/v1",
      "      apiKeyEnv: OPENROUTER_API_KEY",
    ].join("\n")
  );

  return { root, workspace, config };
}

describe("CLI integration", () => {
  it("uses the current directory as the default workspace", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.root, "marker.txt"), "");

    const { stdout } = await runCli(["--config", fixture.config], fixture.root);

    expect(stdout).toContain("Topchester");
    expect(stdout).toContain(`workspace: ${fixture.root}`);
    expect(stdout).toContain("agent.primary: qwen/qwen3-coder:free");
    expect(stdout).toContain("default: openrouter");
    expect(stdout).toContain("openrouter: openai-compatible https://openrouter.ai/api/v1 auth=env:OPENROUTER_API_KEY");
    expect(stdout).toContain("│ >");
    expect(stdout).toContain(
      `status: ready · folder: ${fixture.root.split("/").at(-1)} · model: qwen/qwen3-coder:free [openrouter]`
    );
  });

  it("keeps a relative config path relative to the caller cwd when workspace is overridden", async () => {
    const fixture = await makeFixture();
    const relativeConfig = "config.yaml";

    const { stdout } = await runCli(["--config", relativeConfig, "--workspace", fixture.workspace], fixture.root);

    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain("agent.primary: qwen/qwen3-coder:free");
    expect(stdout).not.toContain("model assignments: none configured");
  });

  it("accepts repeatable dev flags", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(
      ["--config", fixture.config, "--dev", "disable-kb-check-modal", "--dev", "do-something-other", "dev"],
      fixture.root
    );

    expect(stdout).toContain("dev flags: disable-kb-check-modal, do-something-other");
  });

  it("reports missing KB status with explicit workspace", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "status"], fixture.root);

    expect(stdout).toContain("KB status");
    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain(`knowledge folder: ${join(fixture.workspace, "topchester-kb")} [missing] (default)`);
    expect(stdout).toContain("state: no knowledge base found yet");
  });

  it("reports present KB status", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "topchester-kb"), { recursive: true });

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "status"], fixture.root);

    expect(stdout).toContain(`knowledge folder: ${join(fixture.workspace, "topchester-kb")} [ok] (default)`);
    expect(stdout).toContain(
      `local cache folder: ${join(fixture.workspace, ".agents/topchester-kb-cache")} [missing] (default)`
    );
    expect(stdout).toContain("state: knowledge base found");
  });
});
