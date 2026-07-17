import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), "topchester-package-check-"));
const maxBuffer = 30 * 1024 * 1024;

try {
  await run("vp", ["run", "build"], { cwd: root, maxBuffer });
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: root,
    env: { ...process.env, npm_config_cache: join(destination, "npm-cache") },
    maxBuffer,
  });
  const packed = JSON.parse(stdout) as Array<{ filename?: string; files?: Array<{ path?: string }> }>;
  const paths = new Set(
    packed[0]?.files?.map((file) => file.path).filter((path): path is string => Boolean(path)) ?? []
  );
  const required = [
    "dist/bin.mjs",
    "skills/topchester/SKILL.md",
    "skills/topchester/references/configuration.md",
    "skills/topchester/references/knowledge-base.md",
    "skills/topchester/references/commands.md",
    "skills/topchester/references/troubleshooting.md",
    "resources/knowledge/topchester/manifest.json",
  ];
  const missing = required.filter((path) => !paths.has(path));
  const hasProductEntry = [...paths].some((path) => path.startsWith("resources/knowledge/topchester/l1-files/"));
  if (missing.length > 0 || !hasProductEntry) {
    throw new Error(
      `Package contents are incomplete.${missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""}${!hasProductEntry ? " No product L1 entries were packed." : ""}`
    );
  }

  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report an artifact filename.");
  const prefix = join(destination, "installed");
  await mkdir(prefix, { recursive: true });
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      "--prefix",
      prefix,
      join(destination, filename),
    ],
    {
      cwd: root,
      env: { ...process.env, npm_config_cache: join(destination, "npm-cache") },
      maxBuffer,
      timeout: 120_000,
    }
  );

  const installedPackage = join(prefix, "node_modules", "topchester-ai");
  const cli = join(installedPackage, "dist", "bin.mjs");
  const nativePackage = join(
    prefix,
    "node_modules",
    "@opentui",
    `core-${process.platform}-${process.arch}`,
    "package.json"
  );
  await access(nativePackage);
  const installedMetadata = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (installedMetadata.dependencies?.["@earendil-works/pi-tui"]) {
    throw new Error("Packed metadata still depends on pi-tui.");
  }

  const fixture = join(destination, "fixture");
  await mkdir(join(fixture, ".git"), { recursive: true });
  const env = {
    ...process.env,
    HOME: fixture,
    TOPCHESTER_CONFIG: "",
    TOPCHESTER_LOG_FILE: "",
    TOPCHESTER_LOG_LEVEL: "silent",
  };
  const version = await run("bun", [cli, "--version"], { env, maxBuffer });
  if (!version.stdout.includes("0.76.0")) {
    throw new Error(`Packed Bun CLI returned an unexpected version: ${version.stdout.trim()}`);
  }
  const sources = await run("bun", [cli, "--workspace", fixture, "kb", "sources"], { env, maxBuffer });
  if (!sources.stdout.includes("topchester\tbuiltin-product\tready\tread-only")) {
    throw new Error("Packed CLI did not load its version-matched built-in product source.");
  }
  const search = await run(
    "bun",
    [cli, "--workspace", fixture, "kb", "search", "--source", "topchester", "ignore", "paths"],
    { env, maxBuffer }
  );
  if (!search.stdout.includes("topchester:docs/configuration/ignore-paths.md")) {
    throw new Error("Packed CLI could not search its built-in product source.");
  }

  console.log(
    `Package contains ${paths.size} files; its isolated Bun install includes @opentui/core-${process.platform}-${process.arch} and passes product-knowledge checks.`
  );
} finally {
  await rm(destination, { recursive: true, force: true });
}
