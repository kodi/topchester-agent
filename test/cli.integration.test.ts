import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CODEX_CLIENT_ID, CODEX_ISSUER } from "../src/auth/codex.js";
import { writeAuthStore } from "../src/auth/store.js";
import { runTopchesterCli } from "../src/cli.js";
import { createSession, type SessionHandle } from "../src/session/store.js";

const execFileAsync = promisify(execFile);

interface CliResult {
  stdout: string;
  stderr: string;
}

class CliError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: string[], code: number, stdout: string, stderr: string) {
    super(`Command failed: topchester ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.chdir(cwd);
  process.env = {
    ...originalEnv,
    HOME: cwd,
    TOPCHESTER_CONFIG: "",
    TOPCHESTER_LOG_FILE: "",
    TOPCHESTER_LOG_LEVEL: "",
    ...env,
  };
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...values: unknown[]) => {
    stdoutChunks.push(`${values.map(String).join(" ")}\n`);
  };
  console.error = (...values: unknown[]) => {
    stderrChunks.push(`${values.map(String).join(" ")}\n`);
  };

  try {
    try {
      await runTopchesterCli(["topchester", "topchester", ...args], { exitOverride: true });
    } catch (error) {
      if (!isCommanderExit(error)) {
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("") || (error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
        throw new CliError(args, 1, stdout, stderr);
      }
    }

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    if (code !== 0) {
      throw new CliError(args, code, stdout, stderr);
    }

    return { stdout, stderr } satisfies CliResult;
  } finally {
    process.chdir(originalCwd);
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
}

function isCommanderExit(error: unknown): error is { code: string; exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "exitCode" in error
  );
}

async function makeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "topchester-cli-")));
  const workspace = join(root, "workspace");
  const config = join(root, "config.jsonc");

  await writeFile(
    config,
    JSON.stringify({
      models: {
        default: "qwen/qwen3-coder:free",
        providers: {
          default: "openrouter",
          openrouter: {
            type: "openai-compatible",
            baseURL: "https://openrouter.ai/api/v1",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
        },
      },
    })
  );

  return { root, workspace, config };
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
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
    expect(docs).toContain("`/restore` opens a previous-session picker");
    expect(docs).toContain("fail before the TUI/static layout opens");
    expect(docs).toContain("V0 does not include a `topchester sessions list` command");
    expect(docs).toContain("## `topchester update`");
    expect(docs).toContain("Detects npm, pnpm, or bun");
    expect(docs).toContain("After a successful update, restart Topchester");
    expect(docs).toContain("## `topchester info`");
    expect(docs).toContain("lite doctor");
    expect(docs).toContain("Reports config layers");
    expect(docs).toContain("## `topchester run`");
    expect(docs).toContain("Routes slash-command prompts such as `/kb status`");
    expect(docs).toContain("Interactive picker commands such as `/model`, `/connect`, and `/restore` are TUI-only");
    expect(docs).toContain("Includes a per-run `runId` in structured logs");
  });

  it("lists resume as a top-level help option", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--help"], fixture.root);

    expect(stdout).toContain("--resume <session>");
  });

  it("lists run as a top-level command", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--help"], fixture.root);

    expect(stdout).toContain("run");
    expect(stdout).toContain("run one prompt or slash command");
  });

  it("lists update as a top-level command", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--help"], fixture.root);

    expect(stdout).toContain("update");
    expect(stdout).toContain("update Topchester with the package manager that");
    expect(stdout).toContain("installed it");
  });

  it("lists info as a top-level command", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(["--help"], fixture.root);

    expect(stdout).toContain("info");
    expect(stdout).toContain("show config and local runtime hints");
  });

  it("prints the package version", async () => {
    const fixture = await makeFixture();
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };

    const { stdout } = await runCli(["--version"], fixture.root);

    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("publishes topchester as a dedicated bin shim", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      bin: { topchester: string };
      version: string;
    };
    const binSource = await readFile(join(process.cwd(), "src", "bin.ts"), "utf8");

    expect(packageJson.bin.topchester).toBe("dist/bin.mjs");
    expect(binSource).toContain("#!/usr/bin/env node");
    expect(binSource).toContain('import { runTopchesterCli } from "./cli.js";');
    expect(binSource).toContain("await runTopchesterCli();");
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

  it("forks an exact saved session and opens the fork in static mode", async () => {
    const fixture = await makeFixture();
    const source = await seedSession(fixture.workspace, "source unique row");
    const other = await seedSession(fixture.workspace, "other unique row");
    const sourceEventsBefore = await readFile(source.eventsPath, "utf8");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "fork", source.sessionId],
      fixture.root
    );

    expect(stdout).toContain("source unique row");
    expect(stdout).not.toContain("other unique row");
    expect(await readFile(source.eventsPath, "utf8")).toBe(sourceEventsBefore);
    const sessionIds = await readdir(join(fixture.workspace, ".agents", "topchester", "sessions"));
    const forkSessionId = sessionIds.find(
      (sessionId) => sessionId !== source.sessionId && sessionId !== other.sessionId
    );
    expect(forkSessionId).toBeDefined();
    expect(await readSessionEvents(fixture.workspace, forkSessionId!)).toBe(sourceEventsBefore);
    const forkMetadata = JSON.parse(
      await readFile(
        join(fixture.workspace, ".agents", "topchester", "sessions", forkSessionId!, "metadata.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(forkMetadata).toMatchObject({
      sessionId: forkSessionId,
      rootSessionId: forkSessionId,
      forkedFromSessionId: source.sessionId,
      forkedFromRootSessionId: source.sessionId,
      source: "user",
    });
  });

  it("forks the latest saved session with --last", async () => {
    const fixture = await makeFixture();
    const older = await seedSession(fixture.workspace, "older unique row");
    const latest = await seedSession(fixture.workspace, "latest unique row");

    const { stdout } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "fork", "--last"],
      fixture.root
    );

    expect(stdout).toContain("latest unique row");
    expect(stdout).not.toContain("older unique row");
    const sessionIds = await readdir(join(fixture.workspace, ".agents", "topchester", "sessions"));
    const forkSessionId = sessionIds.find(
      (sessionId) => sessionId !== older.sessionId && sessionId !== latest.sessionId
    );
    expect(forkSessionId).toBeDefined();
    const forkMetadata = JSON.parse(
      await readFile(
        join(fixture.workspace, ".agents", "topchester", "sessions", forkSessionId!, "metadata.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(forkMetadata.forkedFromSessionId).toBe(latest.sessionId);
  });

  it("fails bare saved-session fork until a picker exists", async () => {
    const fixture = await makeFixture();

    await expect(runCli(["--workspace", fixture.workspace, "fork"], fixture.root)).rejects.toMatchObject({
      stderr: expect.stringContaining("topchester fork requires --last or a session id"),
    });
  });

  it("fails malformed fork sources before opening the TUI", async () => {
    const fixture = await makeFixture();
    const source = await seedSession(fixture.workspace, "broken fork source");
    await writeFile(
      source.eventsPath,
      '{"version":1,"id":1,"ts":"2026-01-01T00:00:00.000Z","kind":"message","role":"user","text":"ok"}\nnot json\n'
    );

    await expect(
      runCli(["--config", fixture.config, "--workspace", fixture.workspace, "fork", source.sessionId], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`Could not read session event in ${source.eventsPath} line 2: invalid JSON`),
    });

    await expect(readdir(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toEqual([
      source.sessionId,
    ]);
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
    const relativeConfig = "config.jsonc";

    const { stdout } = await runCli(["--config", relativeConfig, "--workspace", fixture.workspace], fixture.root);

    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain("agent.primary: qwen/qwen3-coder:free");
    expect(stdout).not.toContain("model assignments: none configured");
  });

  it("accepts repeatable dev flags", async () => {
    const fixture = await makeFixture();

    const { stdout } = await runCli(
      ["--config", fixture.config, "--dev", "alpha", "--dev", "beta", "dev"],
      fixture.root
    );

    expect(stdout).toContain("dev flags: alpha, beta");
  });

  it("reports config and local runtime hints", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.config,
      JSON.stringify({
        models: {
          default: "openrouter/qwen/qwen3-coder:free",
          providers: {
            default: "openrouter",
            openrouter: {
              type: "openai-compatible",
              baseURL: "https://openrouter.ai/api/v1",
              apiKeyEnv: "OPENROUTER_API_KEY",
            },
          },
        },
        mcp: {
          everything: {
            type: "stdio",
            command: "node",
            enabledTools: ["echo"],
          },
        },
        hooks: {
          Stop: [{ command: "true" }],
        },
      })
    );

    const { stdout, stderr } = await runCli(
      ["--config", fixture.config, "--workspace", fixture.workspace, "info"],
      fixture.root,
      {
        OPENROUTER_API_KEY: "",
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("Topchester info");
    expect(stdout).toContain("config:");
    expect(stdout).toContain(`workspace: ${fixture.workspace}`);
    expect(stdout).toContain(`cli --config: ${fixture.config} [ok]`);
    expect(stdout).toContain("status: valid");
    expect(stdout).toContain("agent.primary: openrouter/qwen/qwen3-coder:free");
    expect(stdout).toContain("fallback: openrouter/qwen/qwen3-coder:free");
    expect(stdout).toContain(
      "openrouter: openai-compatible https://openrouter.ai/api/v1 auth=env:OPENROUTER_API_KEY [missing]"
    );
    expect(stdout).toContain("everything: enabled command=node [found] tools=echo");
    expect(stdout).toContain("hooks:");
    expect(stdout).toContain("commands:");
    expect(stdout).toContain(`sessions: ${join(fixture.workspace, ".agents", "topchester", "sessions")}`);
    expect(stdout).toContain(`knowledge: ${join(fixture.workspace, "topchester-kb")} [missing]`);
  });

  it("shows redacted Codex OAuth status in auth status and info", async () => {
    const fixture = await makeFixture();
    const authPath = join(fixture.root, ".config", "topchester", "auth.json");
    const configPath = join(fixture.root, "codex-config.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          default: "codex/gpt-5.5",
        },
      })
    );
    await writeAuthStore(
      {
        version: 1,
        providers: {
          codex: {
            type: "oauth_codex",
            issuer: CODEX_ISSUER,
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            idToken: "id-secret",
            accountId: "account-secret",
            expiresAt: 4_102_444_800_000,
          },
        },
      },
      { path: authPath }
    );

    const statusResult = await runCli(["auth", "status"], fixture.root);
    const infoResult = await runCli(["--config", configPath, "--workspace", fixture.workspace, "info"], fixture.root);

    expect(statusResult.stdout).toContain("Topchester auth status");
    expect(statusResult.stdout).toContain(
      "codex: oauth_codex source=stored state=ok access=yes refresh=yes account=yes"
    );
    expect(statusResult.stdout).not.toContain("secret");
    expect(infoResult.stdout).toContain("codex: openai-compatible https://chatgpt.com/backend-api auth=oauth stored");
    expect(infoResult.stdout).not.toContain("secret");
  });

  it("completes mocked Codex device login without printing token values", async () => {
    const fixture = await makeFixture();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const idToken = jwtWithClaims({ chatgpt_account_id: "account-1" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });

      if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({
            device_auth_id: "device-1",
            user_code: "ABCD-EFGH",
            interval: "1",
            expires_in: 900,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (String(url).endsWith("/api/accounts/deviceauth/token")) {
        return new Response(
          JSON.stringify({
            authorization_code: "authorization-code",
            code_verifier: "code-verifier",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (String(url).endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected fetch: ${String(url)}`);
    }) as typeof globalThis.fetch;

    try {
      const { stdout } = await runCli(["auth", "login", "codex", "--device"], fixture.root);

      expect(stdout).toContain("Codex device login");
      expect(stdout).toContain(`verification URL: ${CODEX_ISSUER}/codex/device`);
      expect(stdout).toContain("user code: ABCD-EFGH");
      expect(stdout).toContain("Codex login saved.");
      expect(stdout).not.toContain("access-secret");
      expect(stdout).not.toContain("refresh-secret");
      expect(stdout).not.toContain(idToken);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map((request) => request.url)).toEqual([
      `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
      `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
      `${CODEX_ISSUER}/oauth/token`,
    ]);
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ client_id: CODEX_CLIENT_ID });
    expect(Object.fromEntries(new URLSearchParams(requests[2]!.init.body as string))).toMatchObject({
      grant_type: "authorization_code",
      code: "authorization-code",
      code_verifier: "code-verifier",
      client_id: CODEX_CLIENT_ID,
    });

    const authFile = await readFile(join(fixture.root, ".config", "topchester", "auth.json"), "utf8");
    const configFile = await readFile(join(fixture.root, ".config", "topchester", "config.jsonc"), "utf8");
    expect(authFile).toContain("refresh-secret");
    expect(configFile).toContain('"codex"');
    expect(configFile).not.toContain("access-secret");
  });

  it("reports invalid config without opening the TUI", async () => {
    const fixture = await makeFixture();
    const badConfig = join(fixture.root, "bad-info-config.jsonc");
    await writeFile(badConfig, '{ "models": { "defaultPurpose": "old" } }\n');

    await expect(
      runCli(["--config", badConfig, "--workspace", fixture.workspace, "info"], fixture.root)
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("status: invalid"),
      stderr: "",
    });
    await expect(
      runCli(["--config", badConfig, "--workspace", fixture.workspace, "info"], fixture.root)
    ).rejects.toMatchObject({
      stdout: expect.stringContaining(
        `Invalid Topchester config at ${badConfig}: models: Unrecognized key: "defaultPurpose"`
      ),
    });
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

  it("runs slash commands without opening the TUI and writes run-scoped logs", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.workspace, "src"), { recursive: true });
    await writeFile(join(fixture.workspace, "src", "index.ts"), "export const value = 1;\n");

    const { stdout } = await runCli(
      ["--workspace", fixture.workspace, "run", "--json", "/kb", "status"],
      fixture.root,
      { TOPCHESTER_LOG_LEVEL: "debug" }
    );
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; runId?: string; event?: { type?: string } });
    const runId = events.find((event) => event.runId)?.runId;

    expect(runId).toBeTruthy();
    expect(events.map((event) => event.type)).toContain("run.started");
    expect(events.map((event) => event.event?.type)).toContain("knowledge_status");
    expect(events.map((event) => event.type)).toContain("session.persisted");
    await expect(readdir(join(fixture.workspace, ".agents", "topchester", "sessions"))).resolves.toHaveLength(1);

    const log = await readFile(join(fixture.workspace, ".agents", "topchester", "logs", "topchester.log"), "utf8");
    expect(log).toContain(`"runId":"${runId}"`);
    expect(log).toContain('"event":"slash_command_dispatch"');
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

  it("searches compiled L1 knowledge entries from the CLI", async () => {
    const fixture = await makeFixture();
    const entryPath = join(fixture.workspace, "topchester-kb", "l1-files", "src", "posts", "post-service.ts.json");
    await mkdir(join(fixture.workspace, "topchester-kb", "l1-files", "src", "posts"), { recursive: true });
    await writeFile(
      entryPath,
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/posts/post-service.ts",
          layer: "L1",
          type: "file",
          path: "src/posts/post-service.ts",
          language: "typescript",
          content_hash: `sha256:${"b".repeat(64)}`,
          size_bytes: 321,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Updates CMS posts and post authors.",
          responsibilities: ["Update the author assigned to a post."],
          symbols: [
            {
              id: "symbol:src/posts/post-service.ts#updatePostAuthor",
              kind: "function",
              name: "updatePostAuthor",
              exported: true,
              summary: "Updates the author for a CMS post.",
            },
          ],
          imports: [],
          exports: ["updatePostAuthor"],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/posts/post-service.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );

    const { stdout } = await runCli(
      ["--workspace", fixture.workspace, "kb", "search", "post", "author", "update"],
      fixture.root
    );

    expect(stdout).toContain("KB search");
    expect(stdout).toContain("entries indexed: 1");
    expect(stdout).toContain("matches: 1");
    expect(stdout).toContain("src/posts/post-service.ts");
    expect(stdout).toContain("symbol matched update");
    expect(stdout).toContain(`sha256:${"b".repeat(64)}`);
  });

  it("supports top-level search as a shortcut for KB search", async () => {
    const fixture = await makeFixture();
    const entryPath = join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json");
    await mkdir(join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
    await writeFile(
      entryPath,
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/tui/status.ts",
          layer: "L1",
          type: "file",
          path: "src/tui/status.ts",
          language: "typescript",
          content_hash: `sha256:${"c".repeat(64)}`,
          size_bytes: 222,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Renders the TUI status bar.",
          responsibilities: ["Show status bar details."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/tui/status.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );

    const { stdout } = await runCli(["--workspace", fixture.workspace, "search", "status", "bar"], fixture.root);

    expect(stdout).toContain("KB search");
    expect(stdout).toContain("query: status bar");
    expect(stdout).toContain("src/tui/status.ts");
  });

  it("prints full JSON for search commands when requested", async () => {
    const fixture = await makeFixture();
    const entryPath = join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json");
    await mkdir(join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
    await writeFile(
      entryPath,
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/tui/status.ts",
          layer: "L1",
          type: "file",
          path: "src/tui/status.ts",
          language: "typescript",
          content_hash: `sha256:${"d".repeat(64)}`,
          size_bytes: 222,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Renders the TUI status bar.",
          responsibilities: ["Show status bar details."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/tui/status.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );

    const { stdout } = await runCli(
      ["--workspace", fixture.workspace, "search", "--json", "status", "bar"],
      fixture.root
    );
    const parsed = JSON.parse(stdout) as {
      query: string;
      entryCount: number;
      matches: Array<{ path: string; contentHash: string; reasons: string[] }>;
    };

    expect(parsed.query).toBe("status bar");
    expect(parsed.entryCount).toBe(1);
    expect(parsed.matches[0]?.path).toBe("src/tui/status.ts");
    expect(parsed.matches[0]?.contentHash).toBe(`sha256:${"d".repeat(64)}`);
    expect(parsed.matches[0]?.reasons).toContain("path matched status");
  });

  it("creates JSON context packs from compiled L1 entries", async () => {
    const fixture = await makeFixture();
    const entryPath = join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json");
    await mkdir(join(fixture.workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
    await writeFile(
      entryPath,
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/tui/status.ts",
          layer: "L1",
          type: "file",
          path: "src/tui/status.ts",
          language: "typescript",
          content_hash: `sha256:${"e".repeat(64)}`,
          size_bytes: 222,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Renders the TUI status bar.",
          responsibilities: ["Show status bar details."],
          symbols: [
            {
              id: "symbol:src/tui/status.ts#renderStatusBar",
              kind: "function",
              name: "renderStatusBar",
              exported: true,
              summary: "Renders the terminal status bar.",
            },
          ],
          imports: [],
          exports: ["renderStatusBar"],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/tui/status.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );

    const { stdout } = await runCli(
      ["--workspace", fixture.workspace, "kb", "context", "--json", "status", "bar"],
      fixture.root
    );
    const parsed = JSON.parse(stdout) as {
      query: string;
      drift: { status: string };
      relevantFiles: Array<{
        path: string;
        l1: { summary: string; symbols: Array<{ name: string }>; omitted?: unknown; imports?: unknown[] };
        fullL1?: unknown;
      }>;
    };

    expect(parsed.query).toBe("status bar");
    expect(parsed.drift.status).toBe("unchecked");
    expect(parsed.relevantFiles[0]?.path).toBe("src/tui/status.ts");
    expect(parsed.relevantFiles[0]?.l1.symbols[0]?.name).toBe("renderStatusBar");
    expect(parsed.relevantFiles[0]?.l1.omitted).toBeUndefined();
    expect(parsed.relevantFiles[0]?.l1.imports).toBeUndefined();
    expect(parsed.relevantFiles[0]?.fullL1).toBeUndefined();

    const fullResult = await runCli(
      ["--workspace", fixture.workspace, "kb", "context", "--json", "--full-l1", "status", "bar"],
      fixture.root
    );
    const fullParsed = JSON.parse(fullResult.stdout) as {
      relevantFiles: Array<{ fullL1?: { evidence: Array<{ value: string }> } }>;
    };

    expect(fullParsed.relevantFiles[0]?.fullL1?.evidence[0]?.value).toBe("src/tui/status.ts");
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

  it("fails full sync clearly before init without writing L1 artifacts", async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.workspace, { recursive: true });
    await writeFile(join(fixture.workspace, "index.ts"), "export const value = 1;\n");

    await expect(
      runCli(["--config", fixture.config, "--workspace", fixture.workspace, "kb", "sync", "--full"], fixture.root)
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Run `topchester kb init` before syncing the project knowledge base."),
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

  it("fails full sync clearly when no kb.summarize model or fallback is configured", async () => {
    const fixture = await makeFixture();
    const badConfig = join(fixture.root, "bad-config.jsonc");
    await writeFile(
      badConfig,
      JSON.stringify({
        models: {
          "kb.summarize": {
            name: "fake-model",
            provider: "missing-provider",
          },
        },
      })
    );
    await mkdir(fixture.workspace, { recursive: true });
    await writeFile(join(fixture.workspace, "index.ts"), "export const value = 1;\n");
    await runCli(["--workspace", fixture.workspace, "kb", "init"], fixture.root);

    await expect(
      runCli(["--config", badConfig, "--workspace", fixture.workspace, "kb", "sync", "--full"], fixture.root)
    ).rejects.toMatchObject({
      message: expect.stringContaining('No provider configured for model provider "missing-provider".'),
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
