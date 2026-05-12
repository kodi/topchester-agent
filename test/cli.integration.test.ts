import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, stat, writeFile } from "node:fs/promises";
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
      TOPCHESTER_LOG_FILE: "",
      TOPCHESTER_LOG_LEVEL: "",
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
      `status: ready · folder: ${fixture.root.split("/").at(-1)} · qwen/qwen3-coder:free [openrouter]`
    );
  });

  it("prepares local session folders on startup without creating KB folders", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--config", fixture.config, "--workspace", fixture.workspace], fixture.root);

    expect(stdout).toContain("Topchester");
    await expect(stat(join(fixture.workspace, ".agents", "topchester"))).resolves.toMatchObject({});
    await expect(stat(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toMatchObject({});
    await expect(stat(join(fixture.workspace, "topchester-kb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fixture.workspace, ".agents", "topchester-kb-cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("startup ignores fake home and other-workspace sessions", async () => {
    const fixture = await makeFixture();
    const otherWorkspace = join(fixture.root, "other-workspace");
    const fakeHome = join(fixture.root, "fake-home");
    await mkdir(join(otherWorkspace, ".agents", "topchester", "sessions", "019b0da2-0000-7000-8000-000000000001"), {
      recursive: true,
    });
    await mkdir(join(fakeHome, ".agents", "topchester", "sessions", "019b0da2-0000-7000-8000-000000000002"), {
      recursive: true,
    });

    await runCli(["--config", fixture.config, "--workspace", fixture.workspace], fixture.root);

    await expect(stat(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toMatchObject({});
    await expect(
      stat(join(fixture.workspace, ".agents", "topchester", "sessions", "019b0da2-0000-7000-8000-000000000001"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(fixture.workspace, ".agents", "topchester", "sessions", "019b0da2-0000-7000-8000-000000000002"))
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it("initializes project knowledge folders", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "init"], fixture.root);

    expect(stdout).toContain("KB init");
    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain(`created: ${join(fixture.workspace, ".agents/topchester")}`);
    expect(stdout).toContain(`created: ${join(fixture.workspace, "topchester-kb")}`);
    await expect(stat(join(fixture.workspace, ".agents/topchester"))).resolves.toMatchObject({});
    await expect(stat(join(fixture.workspace, ".agents/topchester/logs"))).resolves.toMatchObject({});
    await expect(stat(join(fixture.workspace, "topchester-kb"))).resolves.toMatchObject({});
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

  it("resets project knowledge folders", async () => {
    const fixture = await makeFixture();
    const kbPath = join(fixture.workspace, "topchester-kb");
    const cachePath = join(fixture.workspace, ".agents/topchester-kb-cache");
    await mkdir(kbPath, { recursive: true });
    await mkdir(cachePath, { recursive: true });
    await writeFile(join(kbPath, "manifest.json"), "{}\n");
    await writeFile(join(cachePath, "l1-queue.json"), "[]\n");

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "reset"], fixture.root);

    expect(stdout).toContain("KB reset");
    expect(stdout).toContain(`removed: ${kbPath}`);
    expect(stdout).toContain(`removed: ${cachePath}`);
    expect(stdout).toContain("state: project knowledge base was reset");
    await expect(stat(kbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails compile clearly before init without writing L1 artifacts", async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.workspace, { recursive: true });
    await writeFile(join(fixture.workspace, "index.ts"), "export const value = 1;\n");

    await expect(
      runCli(["--config", fixture.config, "--workspace", fixture.workspace, "kb", "compile"], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Run `topchester kb init` before compiling the project knowledge base."),
    });
    await expect(stat(join(fixture.workspace, ".agents/topchester-kb-cache/l1-queue.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(fixture.workspace, "topchester-kb/manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails compile clearly when no kb.summarize model or fallback is configured", async () => {
    const fixture = await makeFixture();
    const badConfig = join(fixture.root, "bad-config.yaml");
    await writeFile(
      badConfig,
      ["models:", "  assignments:", "    agent.primary:", "      name: fake-model"].join("\n")
    );
    await mkdir(fixture.workspace, { recursive: true });
    await writeFile(join(fixture.workspace, "index.ts"), "export const value = 1;\n");
    await runCli(["--workspace", fixture.workspace, "kb", "init"], fixture.root);

    await expect(
      runCli(["--config", badConfig, "--workspace", fixture.workspace, "kb", "compile"], fixture.root)
    ).rejects.toMatchObject({
      message: expect.stringContaining('No model configured for purpose "kb.summarize".'),
    });
    await expect(readdir(join(fixture.workspace, "topchester-kb/l1-files"))).resolves.toEqual([]);
  });
});
