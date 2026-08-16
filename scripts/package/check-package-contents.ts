import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { getCurrentStandaloneTarget } from "../standalone/targets.js";

const run = promisify(execFile);
const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), "topchester-package-check-"));
const maxBuffer = 30 * 1024 * 1024;
const npmExecutable = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const target = getCurrentStandaloneTarget();
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json does not contain a valid version.");
}

try {
  await run("vp", ["run", "build:standalone"], { cwd: root, maxBuffer });
  await run("vp", ["run", "build:npm-release"], { cwd: root, maxBuffer });

  const platformDirectory = join(root, "dist", "npm", target.npmAliasName);
  const platformMetadata = JSON.parse(await readFile(join(platformDirectory, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  const platformVersion = `${packageMetadata.version}-${target.npmDistTag}`;
  if (platformMetadata.name !== "topchester-ai" || platformMetadata.version !== platformVersion) {
    throw new Error(`The ${target.id} artifact must be topchester-ai@${platformVersion}.`);
  }
  const platformPackage = await packPackage(platformDirectory);
  const metaDirectory = join(root, "dist", "npm", "topchester-ai");
  const releaseMetadata = JSON.parse(await readFile(join(metaDirectory, "package.json"), "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  const platformSpec = `npm:topchester-ai@${platformVersion}`;
  if (releaseMetadata.optionalDependencies?.[target.npmAliasName] !== platformSpec) {
    throw new Error(`The release launcher does not alias ${target.npmAliasName} to ${platformSpec}.`);
  }
  await useLocalPlatformTarball(metaDirectory, platformPackage.path);
  const metaPackage = await packPackage(metaDirectory);
  requirePaths(platformPackage.paths, ["bin/topchester", "LICENSE"]);
  requirePaths(metaPackage.paths, ["bin/topchester.exe", "postinstall.mjs", "targets.json", "LICENSE", "README.md"]);

  const prefix = join(destination, "installed");
  await mkdir(prefix, { recursive: true });
  await run(
    npmExecutable,
    ["install", "--no-audit", "--no-fund", "--loglevel", "error", "--prefix", prefix, metaPackage.path],
    {
      cwd: destination,
      env: npmEnvironment(),
      maxBuffer,
      timeout: 120_000,
    }
  );

  const installedPackage = join(prefix, "node_modules", "topchester-ai");
  const installedBinary = join(installedPackage, "bin", "topchester.exe");
  const cli = join(prefix, "node_modules", ".bin", "topchester");
  await access(installedBinary);
  await access(cli);
  const installedMetadata = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
  };
  if (installedMetadata.engines?.bun) {
    throw new Error("The topchester-ai launcher still requires Bun.");
  }
  const workspace = join(destination, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    ...process.env,
    HOME: destination,
    PATH: "/usr/bin:/bin",
    TOPCHESTER_CONFIG: "",
    TOPCHESTER_LOG_FILE: "",
    TOPCHESTER_LOG_LEVEL: "silent",
  };
  const version = await run(cli, ["--version"], { env, maxBuffer });
  if (version.stdout.trim() !== packageMetadata.version) {
    throw new Error(`Installed native CLI returned ${version.stdout.trim()}, expected ${packageMetadata.version}.`);
  }
  const skills = await run(cli, ["--workspace", workspace, "run", "/skills", "list"], { env, maxBuffer });
  if (!skills.stdout.includes("topchester")) {
    throw new Error("Installed native CLI did not load its embedded built-in skills.");
  }

  console.log(
    `Packed and installed topchester-ai with ${target.npmAliasName}; the native CLI passes without Bun on PATH.`
  );
} finally {
  await rm(destination, { recursive: true, force: true });
}

async function packPackage(directory: string): Promise<{ path: string; paths: Set<string> }> {
  const stagingDirectory = join(destination, `pack-${basename(directory)}`);
  await cp(directory, stagingDirectory, { recursive: true });
  const { stdout } = await run(
    npmExecutable,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: stagingDirectory,
      env: npmEnvironment(),
      maxBuffer,
    }
  );
  const result = JSON.parse(stdout) as Array<{ filename?: string; files?: Array<{ path?: string }> }>;
  const filename = result[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report an artifact for ${directory}.`);

  return {
    path: join(destination, filename),
    paths: new Set(result[0]?.files?.flatMap((file) => (file.path ? [file.path] : [])) ?? []),
  };
}

function requirePaths(paths: Set<string>, required: readonly string[]): void {
  const missing = required.filter((path) => !paths.has(path));
  if (missing.length > 0) {
    throw new Error(`Packed npm package is missing: ${missing.join(", ")}.`);
  }
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
