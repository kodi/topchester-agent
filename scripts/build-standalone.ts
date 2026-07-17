/// <reference types="bun" />

import solidPlugin from "@opentui/solid/bun-plugin";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const root = process.cwd();
const targetName = `topchester-${process.platform}-${process.arch}`;
const executableName = process.platform === "win32" ? "topchester.exe" : "topchester";
const embeddedPackageRoot = process.platform === "win32" ? "B:/~BUN/root" : "/$bunfs/root";
const output = join(root, "dist", "standalone", targetName, "bin", executableName);
const generatedEntry = join(root, "scripts", "opentui", ".standalone-entry.generated.ts");
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };

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

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await writeFile(generatedEntry, source);

try {
  const result = await Bun.build({
    entrypoints: [generatedEntry],
    root: ".",
    format: "esm",
    minify: true,
    packages: "bundle",
    naming: { asset: "[dir]/[name].[ext]" },
    plugins: [solidPlugin],
    define: {
      TOPCHESTER_BUILTIN_SKILL_FILES: JSON.stringify(builtinSkillFiles),
      TOPCHESTER_PACKAGE_ROOT: JSON.stringify(embeddedPackageRoot),
      TOPCHESTER_VERSION: JSON.stringify(packageMetadata.version),
    },
    compile: { outfile: output },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Standalone Bun build failed.");
  }

  if (process.platform !== "win32") {
    await chmod(output, 0o755);
  }
  console.log(`Built ${relative(root, output)} with ${assetPaths.length} embedded assets.`);
} finally {
  await rm(generatedEntry, { force: true });
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
