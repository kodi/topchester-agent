import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStandaloneTargets } from "../standalone/targets.js";

const NPM_PACKAGE_NAME = "topchester-ai";

interface RootPackageMetadata {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  repository?: unknown;
}

const root = process.cwd();
const outputRoot = join(root, "dist", "npm");
const rootMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as RootPackageMetadata;
const productManifest = JSON.parse(
  await readFile(join(root, "resources", "knowledge", "topchester", "manifest.json"), "utf8")
) as { productVersion?: unknown };

if (rootMetadata.name !== NPM_PACKAGE_NAME) {
  throw new Error(`The npm release builder expects the root package name to be ${NPM_PACKAGE_NAME}.`);
}
if (typeof rootMetadata.version !== "string" || rootMetadata.version.length === 0) {
  throw new Error("package.json does not contain a valid version.");
}
const releaseVersion = rootMetadata.version;
if (productManifest.productVersion !== releaseVersion) {
  throw new Error(
    `Product knowledge is version ${String(productManifest.productVersion)}, but the npm release is ${releaseVersion}. Run the product-knowledge sync after bumping the version.`
  );
}

const targets = resolveStandaloneTargets(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const target of targets) {
  const sourceBinary = join(root, "dist", "standalone", target.directoryName, "bin", target.executableName);
  await access(sourceBinary);

  const packageDirectory = join(outputRoot, target.npmAliasName);
  const packageBinary = join(packageDirectory, "bin", target.executableName);
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await copyFile(sourceBinary, packageBinary);
  await chmod(packageBinary, 0o755);
  await copyFile(join(root, "LICENSE"), join(packageDirectory, "LICENSE"));
  await writeJson(join(packageDirectory, "package.json"), {
    name: NPM_PACKAGE_NAME,
    version: platformPackageVersion(releaseVersion, target.npmDistTag),
    description: `Standalone Topchester executable for ${target.id}.`,
    license: rootMetadata.license,
    repository: rootMetadata.repository,
    preferUnplugged: true,
    os: [target.platform],
    cpu: [target.arch],
    ...(target.libc ? { libc: [target.libc] } : {}),
    topchesterRelease: {
      kind: "platform",
      target: target.id,
      distTag: target.npmDistTag,
    },
    files: ["bin", "LICENSE"],
  });
}

const metaDirectory = join(outputRoot, NPM_PACKAGE_NAME);
await mkdir(join(metaDirectory, "bin"), { recursive: true });
await copyFile(join(root, "LICENSE"), join(metaDirectory, "LICENSE"));
await copyFile(join(root, "README.md"), join(metaDirectory, "README.md"));
await copyFile(join(root, "scripts", "package", "npm-postinstall.mjs"), join(metaDirectory, "postinstall.mjs"));
await writeFile(
  join(metaDirectory, "bin", "topchester.exe"),
  [
    "#!/usr/bin/env node",
    'console.error("Topchester\'s native executable was not installed.");',
    'console.error("Reinstall topchester-ai with install scripts enabled, or run: node postinstall.mjs");',
    "process.exit(1);",
    "",
  ].join("\n")
);
await chmod(join(metaDirectory, "bin", "topchester.exe"), 0o755);
await writeJson(
  join(metaDirectory, "targets.json"),
  targets.map((target) => ({
    id: target.id,
    platform: target.platform,
    arch: target.arch,
    ...(target.libc ? { libc: target.libc } : {}),
    packageName: target.npmAliasName,
    packageVersion: platformPackageVersion(releaseVersion, target.npmDistTag),
    executableName: target.executableName,
  }))
);
await writeJson(join(metaDirectory, "package.json"), {
  name: NPM_PACKAGE_NAME,
  version: releaseVersion,
  description: rootMetadata.description,
  license: rootMetadata.license,
  repository: rootMetadata.repository,
  type: "module",
  bin: { topchester: "bin/topchester.exe" },
  scripts: { postinstall: "node postinstall.mjs" },
  optionalDependencies: Object.fromEntries(
    targets.map((target) => [
      target.npmAliasName,
      `npm:${NPM_PACKAGE_NAME}@${platformPackageVersion(releaseVersion, target.npmDistTag)}`,
    ])
  ),
  os: [...new Set(targets.map((target) => target.platform))],
  cpu: [...new Set(targets.map((target) => target.arch))],
  engines: { node: ">=18" },
  topchesterRelease: { kind: "launcher" },
  files: ["bin", "postinstall.mjs", "targets.json", "LICENSE", "README.md"],
});

console.log(
  `Staged ${NPM_PACKAGE_NAME}@${releaseVersion} and ${targets.length} platform-tagged version${targets.length === 1 ? "" : "s"} in dist/npm.`
);

function platformPackageVersion(version: string, distTag: string): string {
  return `${version}-${distTag}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
