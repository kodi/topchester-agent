import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), "topchester-package-check-"));

try {
  await run("vp", ["run", "build"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: root,
    env: { ...process.env, npm_config_cache: join(destination, "npm-cache") },
    maxBuffer: 20 * 1024 * 1024,
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
  const unpacked = join(destination, "unpacked");
  const fixture = join(destination, "fixture");
  await mkdir(join(fixture, ".git"), { recursive: true });
  await mkdir(unpacked, { recursive: true });
  await run("tar", ["-xzf", join(destination, filename), "-C", unpacked]);
  await symlink(join(root, "node_modules"), join(unpacked, "package", "node_modules"), "dir");
  const cli = join(unpacked, "package", "dist", "bin.mjs");
  const env = {
    ...process.env,
    HOME: fixture,
    TOPCHESTER_CONFIG: "",
    TOPCHESTER_LOG_FILE: "",
    TOPCHESTER_LOG_LEVEL: "silent",
  };
  const sources = await run(process.execPath, [cli, "--workspace", fixture, "kb", "sources"], { env });
  if (!sources.stdout.includes("topchester\tbuiltin-product\tready\tread-only")) {
    throw new Error("Packed CLI did not load its version-matched built-in product source.");
  }
  const search = await run(
    process.execPath,
    [cli, "--workspace", fixture, "kb", "search", "--source", "topchester", "ignore", "paths"],
    { env }
  );
  if (!search.stdout.includes("topchester:docs/configuration/ignore-paths.md")) {
    throw new Error("Packed CLI could not search its built-in product source.");
  }
  console.log(
    `Package contains ${paths.size} files and the packed CLI loads and searches its Topchester product source.`
  );
} finally {
  await rm(destination, { recursive: true, force: true });
}
