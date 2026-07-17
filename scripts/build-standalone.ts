/// <reference types="bun" />

import solidPlugin from "@opentui/solid/bun-plugin";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { resolveStandaloneTargets, type StandaloneTarget } from "./standalone/targets.js";

const root = process.cwd();
const standaloneRoot = join(root, "dist", "standalone");
const generatedEntry = join(standaloneRoot, ".standalone-entry.generated.ts");
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
const buildArgs = process.argv.slice(2);
const targets = resolveStandaloneTargets(buildArgs);

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json does not contain a valid version.");
}

const assetPaths = [
  "package.json",
  ...(await listFiles(join(root, "skills"))).map((path) => relative(root, path)),
  ...(await listFiles(join(root, "resources", "knowledge"))).map((path) => relative(root, path)),
].sort();
const builtinSkillFiles = assetPaths
  .filter((path) => path.startsWith("skills/"))
  .map((path) => path.slice("skills/".length));

const imports = assetPaths.map((path, index) => {
  const specifier = toImportSpecifier(relative(dirname(generatedEntry), join(root, path)));
  return `import embeddedAsset${index} from ${JSON.stringify(specifier)} with { type: "file" };`;
});
const embeddedAssets = assetPaths.map((_path, index) => `embeddedAsset${index}`);
const source = [
  ...imports,
  'import { runTopchesterCli } from "../../src/cli.js";',
  "",
  `const embeddedAssets = [${embeddedAssets.join(", ")}];`,
  'if (embeddedAssets.some((path) => typeof path !== "string")) {',
  '  throw new Error("Standalone assets were not embedded correctly.");',
  "}",
  "",
  "await runTopchesterCli();",
  "",
].join("\n");

if (buildArgs.includes("--all")) {
  await rm(standaloneRoot, { recursive: true, force: true });
}
await mkdir(standaloneRoot, { recursive: true });
await writeFile(generatedEntry, source);

try {
  for (const target of targets) {
    await buildTarget(target, packageMetadata.version, assetPaths.length, builtinSkillFiles);
  }
} finally {
  await rm(generatedEntry, { force: true });
}

async function buildTarget(
  target: StandaloneTarget,
  version: string,
  assetCount: number,
  skillFiles: readonly string[]
): Promise<void> {
  const targetDirectory = join(root, "dist", "standalone", target.directoryName);
  const output = join(targetDirectory, "bin", target.executableName);
  const embeddedPackageRoot = "/$bunfs/root";
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });

  const result = await Bun.build({
    entrypoints: [generatedEntry],
    root: ".",
    conditions: ["bun", "node"],
    format: "esm",
    minify: true,
    packages: "bundle",
    naming: { asset: "[dir]/[name].[ext]" },
    plugins: [solidPlugin],
    define: {
      TOPCHESTER_BUILTIN_SKILL_FILES: JSON.stringify(skillFiles),
      TOPCHESTER_PACKAGE_ROOT: JSON.stringify(embeddedPackageRoot),
      TOPCHESTER_VERSION: JSON.stringify(version),
      ...(target.platform === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(target.libc) } : {}),
    },
    compile: {
      target: target.bunTarget,
      outfile: output,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Standalone Bun build failed for ${target.id}.`);
  }

  await chmod(output, 0o755);
  await writeFile(
    join(targetDirectory, "target.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        id: target.id,
        platform: target.platform,
        arch: target.arch,
        ...(target.libc ? { libc: target.libc } : {}),
        bunTarget: target.bunTarget,
        version,
      },
      null,
      2
    )}\n`
  );
  console.log(`Built ${relative(root, output)} with ${assetCount} embedded assets.`);
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function toImportSpecifier(path: string): string {
  const normalized = path.split(sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
