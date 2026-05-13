import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSession, type SessionHandle } from "../src/session/store.js";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "src/cli.ts");
const tsxPath = join(process.cwd(), "node_modules/.bin/tsx");

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(tsxPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      TOPCHESTER_CONFIG: "",
      TOPCHESTER_LOG_FILE: "",
      TOPCHESTER_LOG_LEVEL: "",
      ...env,
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
  it("documents resume session behavior in CLI docs", async () => {
    const docs = await readFile(join(process.cwd(), "docs", "cli.md"), "utf8");

    expect(docs).toContain("--resume <session>");
    expect(docs).toContain(".agents/topchester/sessions/");
    expect(docs).toContain("Plain `topchester` starts a fresh session");
    expect(docs).toContain("does not auto-resume");
    expect(docs).toContain("`--resume latest` restores the newest project-local session");
    expect(docs).toContain("`--resume <session-id>` restores that exact project-local session");
    expect(docs).toContain("append to the selected session log");
    expect(docs).toContain("fail before the TUI/static layout opens");
    expect(docs).toContain("V0 does not include a `topchester sessions list` command");
  });

  it("lists resume as a top-level help option", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--help"], fixture.root);

    expect(stdout).toContain("--resume <session>");
  });

  it("prints the package version", async () => {
    const fixture = await makeFixture();
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };

    const { stdout } = await runCli(["--version"], fixture.root);

    expect(stdout.trim()).toBe(packageJson.version);
  });

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
    expect(stdout).toContain(`● ready ·  ${fixture.root.split("/").at(-1)} · qwen/qwen3-coder:free [openrouter]`);
  });

  it("prepares local session folders on startup without creating KB folders", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--config", fixture.config, "--workspace", fixture.workspace], fixture.root);

    expect(stdout).toContain("Topchester");
    await expect(stat(join(fixture.workspace, ".agents", "topchester"))).resolves.toMatchObject({});
    await expect(stat(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toMatchObject({});
    const sessionIds = await readdir(join(fixture.workspace, ".agents", "topchester", "sessions"));
    expect(sessionIds).toHaveLength(1);
    const events = await readSessionEvents(fixture.workspace, sessionIds[0]!);
    expect(events).toContain("Ask Topchester what you want to change.");
    await expect(stat(join(fixture.workspace, "topchester-kb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fixture.workspace, ".agents", "topchester-kb-cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("starts fresh by default instead of resuming an old session", async () => {
    const fixture = await makeFixture();
    const oldSession = await seedSession(fixture.workspace, "old unique row");
    const oldEventsBefore = await readFile(oldSession.eventsPath, "utf8");

    const { stdout } = await runCli(["--config", fixture.config, "--workspace", fixture.workspace], fixture.root);

    expect(stdout).not.toContain("old unique row");
    expect(await readFile(oldSession.eventsPath, "utf8")).toBe(oldEventsBefore);
    const sessionIds = await readdir(join(fixture.workspace, ".agents", "topchester", "sessions"));
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds).toContain(oldSession.sessionId);
  });

  it("resumes latest session in static mode", async () => {
    const fixture = await makeFixture();
    const older = await seedSession(fixture.workspace, "older unique row");
    const latest = await seedSession(fixture.workspace, "latest unique row");
    const olderEventsBefore = await readFile(older.eventsPath, "utf8");
    const latestEventsBefore = await readFile(latest.eventsPath, "utf8");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "--resume", "latest"],
      fixture.root
    );

    expect(stdout).toContain("latest unique row");
    expect(stdout).not.toContain("older unique row");
    expect(await readFile(older.eventsPath, "utf8")).toBe(olderEventsBefore);
    expect(await readFile(latest.eventsPath, "utf8")).toBe(latestEventsBefore);
    await expect(readdir(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toHaveLength(2);
  });

  it("does not rewrite existing records when resuming a selected session", async () => {
    const fixture = await makeFixture();
    const selected = await seedSession(fixture.workspace, "selected old row");
    const originalPrefix = await readFile(selected.eventsPath, "utf8");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "--resume", selected.sessionId],
      fixture.root
    );

    expect(stdout).toContain("selected old row");
    expect(await readFile(selected.eventsPath, "utf8")).toBe(originalPrefix);
    await expect(readdir(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toEqual([
      selected.sessionId,
    ]);
  });

  it("resumes an exact session id in static mode", async () => {
    const fixture = await makeFixture();
    const exact = await seedSession(fixture.workspace, "exact unique row");
    const other = await seedSession(fixture.workspace, "other unique row");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "--resume", exact.sessionId],
      fixture.root
    );

    expect(stdout).toContain("exact unique row");
    expect(stdout).not.toContain("other unique row");
    await expect(readdir(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toHaveLength(2);
    expect(await readSessionEvents(fixture.workspace, other.sessionId)).toContain("other unique row");
  });

  it("fails missing and empty latest resume targets before startup", async () => {
    const fixture = await makeFixture();
    const missingId = "019b0da2-0000-7000-8000-000000000099";

    await expect(runCli(["--workspace", fixture.workspace, "--resume", missingId], fixture.root)).rejects.toMatchObject(
      {
        stderr: expect.stringContaining("Session not found"),
      }
    );
    await expect(runCli(["--workspace", fixture.workspace, "--resume", "latest"], fixture.root)).rejects.toMatchObject({
      stderr: expect.stringContaining("No sessions found"),
    });
    await expect(stat(join(fixture.workspace, ".agents", "topchester", "sessions", missingId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails invalid resume values before startup with plain copy", async () => {
    const fixture = await makeFixture();
    const invalidValues = [
      "not-a-uuid",
      "019b0da2-0000-7000-8000",
      "019B0DA2-0000-7000-8000-000000000099",
      "../x",
      join(fixture.root, "x"),
    ];

    for (const value of invalidValues) {
      await expect(runCli(["--workspace", fixture.workspace, "--resume", value], fixture.root)).rejects.toMatchObject({
        stderr: expect.stringContaining("Session id must be an exact lowercase UUIDv7"),
      });
    }
  });

  it("fails malformed resumed sessions before startup with a line-specific plain error", async () => {
    const fixture = await makeFixture();
    const session = await seedSession(fixture.workspace, "broken unique row");
    await writeFile(
      session.eventsPath,
      '{"version":1,"id":1,"ts":"2026-01-01T00:00:00.000Z","kind":"message","role":"user","text":"ok"}\nnot json\n'
    );

    await expect(
      runCli(["--workspace", fixture.workspace, "--resume", session.sessionId], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Could not read session event in ${session.eventsPath} line 2: invalid JSON`),
    });
  });

  it("fails malformed latest safely without mutating session logs or falling back", async () => {
    const fixture = await makeFixture();
    const older = await seedSession(fixture.workspace, "older safe row");
    const latest = await seedSession(fixture.workspace, "latest broken row");
    const olderEventsBefore = await readFile(older.eventsPath, "utf8");
    const latestEventsBefore = `${JSON.stringify({
      version: 1,
      id: 1,
      ts: "2026-01-01T00:00:00.000Z",
      kind: "message",
      role: "user",
      text: "latest broken row",
    })}\nnot json\n`;
    await writeFile(latest.eventsPath, latestEventsBefore);

    await expect(
      runCli(["--config", fixture.config, "--workspace", fixture.workspace, "--resume", "latest"], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Could not read session event in ${latest.eventsPath} line 2: invalid JSON`),
    });

    expect(await readFile(older.eventsPath, "utf8")).toBe(olderEventsBefore);
    expect(await readFile(latest.eventsPath, "utf8")).toBe(latestEventsBefore);
  });

  it("keeps session logs covered by the project git ignore rules", async () => {
    const ignoreFile = await readFile(join(process.cwd(), ".gitignore"), "utf8");

    expect(ignoreFile).toContain(".agents/topchester/");

    const { stdout } = await execFileAsync("git", [
      "-C",
      process.cwd(),
      "check-ignore",
      ".agents/topchester/sessions/example/events.jsonl",
    ]);

    expect(stdout.trim()).toBe(".agents/topchester/sessions/example/events.jsonl");
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
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(join(fixture.workspace, "src", "index.ts"), "export const value = 1;\n");

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "status"], fixture.root);

    expect(stdout).toContain("KB status");
    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain(`knowledge folder: ${join(fixture.workspace, "topchester-kb")} [missing]`);
    expect(stdout).toContain("non-clean files: 1");
    expect(stdout).toContain("non-clean files: 1\n\nmissing_entry\tsrc/index.ts");
    expect(stdout).toContain("missing_entry\tsrc/index.ts");
    expect(stdout).toContain("----\ntotal non-clean files: 1");
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

  it("reports clean KB status when no in-scope files need sync", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "topchester-kb"), { recursive: true });

    const { stdout } = await runCli(["--workspace", fixture.workspace, "kb", "status"], fixture.root);

    expect(stdout).toContain(`knowledge folder: ${join(fixture.workspace, "topchester-kb")} [ok]`);
    expect(stdout).toContain("non-clean files: 0");
    expect(stdout).toContain("state: all in-scope files are current");
    expect(stdout).toContain("----\ntotal non-clean files: 0");
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

  it("dry-runs compile inventory without writing KB artifacts and respects config ignores", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "generated"), { recursive: true });
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await mkdir(join(fixture.workspace, "dist"), { recursive: true });
    await mkdir(join(fixture.workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(fixture.workspace, "topchester.jsonc"), '{ "ignore": { "paths": ["generated/**"] } }\n');
    await writeFile(join(fixture.workspace, ".gitignore"), "dist/\n");
    await writeFile(join(fixture.workspace, "generated", "client.ts"), "ignored\n");
    await writeFile(join(fixture.workspace, "dist", "bundle.js"), "ignored\n");
    await writeFile(join(fixture.workspace, "node_modules", "pkg", "index.js"), "ignored\n");
    await writeFile(join(fixture.workspace, "src", "index.ts"), "export const value = 1;\n");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "kb", "dry-run"],
      fixture.root
    );

    expect(stdout).toContain("KB dry run");
    expect(stdout).toContain("config ignore rules: 1");
    expect(stdout).toContain("files: 2");
    expect(stdout).toContain("missing_entry\t.gitignore");
    expect(stdout).toContain("missing_entry\tsrc/index.ts");
    expect(stdout).toContain("----\ntotal files: 2");
    expect(stdout).not.toContain("sha256:");
    expect(stdout).not.toContain("topchester.jsonc");
    expect(stdout).not.toContain("generated/client.ts");
    expect(stdout).not.toContain("dist/bundle.js");
    expect(stdout).not.toContain("node_modules/pkg/index.js");
    await expect(stat(join(fixture.workspace, ".agents/topchester-kb-cache/l1-queue.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(fixture.workspace, "topchester-kb/manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails sync clearly before init without writing L1 artifacts", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(join(fixture.workspace, "src", "index.ts"), "export const value = 1;\n");

    await expect(
      runCli(["--config", fixture.config, "--workspace", fixture.workspace, "kb", "sync"], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Run `topchester kb init` before syncing the project knowledge base."),
    });
    await expect(stat(join(fixture.workspace, ".agents/topchester-kb-cache/l1-sync-queue.json"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      }
    );
  });

  it("colors the dry-run sync status token when color is enabled", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(join(fixture.workspace, "src", "index.ts"), "export const value = 1;\n");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "kb", "dry-run"],
      fixture.root,
      { FORCE_COLOR: "1", NO_COLOR: "" }
    );

    expect(stdout).toContain("\u001b[33mmissing_entry\u001b[0m\tsrc/index.ts");
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

async function seedSession(workspace: string, text: string): Promise<SessionHandle> {
  const session = await createSession(workspace);
  await session.append({ kind: "message", role: "user", text });
  return session;
}

async function readSessionEvents(workspace: string, sessionId: string): Promise<string> {
  return readFile(join(workspace, ".agents", "topchester", "sessions", sessionId, "events.jsonl"), "utf8");
}
