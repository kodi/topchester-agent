/// <reference types="bun" />

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getCurrentStandaloneTarget } from "../standalone/targets.js";
import { startFakeApi } from "../smoke/fake-api.js";

const run = promisify(execFile);
const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), "topchester-opentui-pty-"));
const fakeApi = await startFakeApi();
const maxBuffer = 30 * 1024 * 1024;
const npmExecutable = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const target = getCurrentStandaloneTarget();

try {
  await run("vp", ["run", "build:standalone"], { cwd: root, maxBuffer });
  await run("vp", ["run", "build:npm-release"], { cwd: root, maxBuffer });
  const platformPackage = await packPackage(join(root, "dist", "npm", target.npmAliasName));
  const metaDirectory = join(root, "dist", "npm", "topchester-ai");
  await useLocalPlatformTarball(metaDirectory, platformPackage);
  const metaPackage = await packPackage(metaDirectory);

  const prefix = join(destination, "installed");
  await run(
    npmExecutable,
    ["install", "--no-audit", "--no-fund", "--loglevel", "error", "--prefix", prefix, metaPackage],
    {
      cwd: root,
      env: npmEnvironment(),
      maxBuffer,
      timeout: 120_000,
    }
  );

  const workspace = join(destination, "workspace");
  const config = join(destination, "config.json");
  const capture = join(destination, "pty-output.bin");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(
    config,
    `${JSON.stringify(
      {
        models: {
          "default": { name: "topchester-pty-fake", provider: "fake" },
          "kb.summarize": { name: "topchester-pty-fake", provider: "fake" },
        },
        providers: {
          default: "fake",
          fake: { type: "openai-compatible", baseURL: fakeApi.baseURL, apiKey: "fake" },
        },
      },
      null,
      2
    )}\n`
  );

  const cli = join(prefix, "node_modules", ".bin", "topchester");
  const installedVersion = await run(cli, ["--version"], {
    env: { ...process.env, HOME: destination, PATH: "/usr/bin:/bin" },
    maxBuffer,
  });
  assert.match(installedVersion.stdout, /^\d+\.\d+\.\d+/u, "the installed native CLI did not start directly");
  const runPty = async (mode: "interactive" | "sigterm" | "sighup", output: string) =>
    run("/usr/bin/expect", [join(root, "scripts", "opentui", "pty-smoke.exp"), mode, cli, config, workspace, output], {
      cwd: root,
      env: { ...process.env, HOME: destination },
      maxBuffer,
      timeout: 90_000,
    });
  await runPty("interactive", capture);
  const signalCaptures: Buffer[] = [];
  for (const mode of ["sigterm", "sighup"] as const) {
    const output = join(destination, `${mode}-output.bin`);
    await runPty(mode, output);
    signalCaptures.push(await readFile(output));
  }

  const output = await readFile(capture);
  const text = output.toString("utf8");
  assert.match(text, /PTY_STREAM_MARKER/u);
  assert.match(text, /Done\./u);
  assert.match(text, /Connect provider/u);
  assert.ok(!text.includes("\u001b[?1049h"), "the production TUI entered the alternate screen");
  assert.ok(text.includes("\u001b[?25h"), "shutdown did not restore the cursor");
  assert.ok(text.includes("\u001b[?2004l"), "shutdown did not disable bracketed paste");
  for (const [index, bytes] of signalCaptures.entries()) {
    const signalOutput = bytes.toString("utf8");
    const signal = index === 0 ? "SIGTERM" : "SIGHUP";
    assert.ok(!signalOutput.includes("\u001b[?1049h"), `${signal} entered the alternate screen`);
    assert.ok(signalOutput.includes("\u001b[?25h"), `${signal} did not restore the cursor`);
    assert.ok(signalOutput.includes("\u001b[?2004l"), `${signal} did not disable bracketed paste`);
  }
  assert.equal(
    fakeApi.requests.some((request) => request.prompt.includes("PTY_STREAM_MARKER")),
    true,
    "the packed CLI did not submit the typed prompt to the mocked model"
  );

  process.stdout.write("Native npm OpenTUI PTY smoke: pass\n");
} finally {
  await fakeApi.close();
  await rm(destination, { recursive: true, force: true });
}

async function packPackage(directory: string): Promise<string> {
  const { stdout } = await run(
    npmExecutable,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: directory,
      env: npmEnvironment(),
      maxBuffer,
    }
  );
  const filename = (JSON.parse(stdout) as Array<{ filename?: string }>)[0]?.filename;
  assert.ok(filename, `npm pack did not report an artifact for ${directory}`);
  return join(destination, filename);
}

async function useLocalPlatformTarball(metaDirectory: string, platformTarball: string): Promise<void> {
  const path = join(metaDirectory, "package.json");
  const metadata = JSON.parse(await readFile(path, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  metadata.optionalDependencies = { [target.npmAliasName]: `file:${platformTarball}` };
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

function npmEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { npm_config_cache: join(destination, "npm-cache") };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
