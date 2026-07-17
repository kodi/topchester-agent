import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  topchesterRelease?: {
    kind?: unknown;
    distTag?: unknown;
  };
}

interface ReleasePackageBase {
  directory: string;
  name: string;
  version: string;
}

type ReleasePackage =
  | (ReleasePackageBase & { kind: "launcher" })
  | (ReleasePackageBase & { kind: "platform"; distTag: string });

const root = process.cwd();
const releaseRoot = join(root, "dist", "npm");
const npmExecutable = join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
const directories = await readdir(releaseRoot, { withFileTypes: true });
const packages: ReleasePackage[] = await Promise.all(
  directories
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const directory = join(releaseRoot, entry.name);
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as PackageMetadata;
      if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
        throw new Error(`${directory}/package.json does not contain a valid name and version.`);
      }
      const kind = metadata.topchesterRelease?.kind;
      if (kind !== "launcher" && kind !== "platform") {
        throw new Error(`${directory}/package.json does not identify a Topchester launcher or platform release.`);
      }
      const distTag = metadata.topchesterRelease?.distTag;
      if (kind === "platform" && typeof distTag !== "string") {
        throw new Error(`${directory}/package.json does not contain a platform dist-tag.`);
      }
      const base = { directory, name: metadata.name, version: metadata.version };
      return kind === "platform" ? { ...base, kind, distTag: distTag as string } : { ...base, kind };
    })
);
const launcherPackages = packages.filter((pkg) => pkg.kind === "launcher");
if (launcherPackages.length !== 1) {
  throw new Error(`dist/npm must contain exactly one topchester-ai launcher; found ${launcherPackages.length}.`);
}
const metaPackage = launcherPackages[0]!;
if (packages.some((pkg) => pkg.name !== metaPackage.name)) {
  throw new Error("Every native npm artifact must use the same topchester-ai package identity.");
}

const platformPackages = packages
  .filter((pkg): pkg is ReleasePackageBase & { kind: "platform"; distTag: string } => pkg.kind === "platform")
  .sort((a, b) => a.version.localeCompare(b.version));
if (platformPackages.length === 0) {
  throw new Error("dist/npm does not contain any platform-tagged topchester-ai versions.");
}
for (const pkg of platformPackages) {
  const expectedVersion = `${metaPackage.version}-${pkg.distTag}`;
  if (pkg.version !== expectedVersion) {
    throw new Error(`${pkg.directory} is ${pkg.name}@${pkg.version}; expected ${pkg.name}@${expectedVersion}.`);
  }
}
for (const pkg of [...platformPackages, metaPackage]) {
  if (isPublished(pkg.name, pkg.version)) {
    console.log(`Already published ${pkg.name}@${pkg.version}; skipping.`);
    continue;
  }

  const args = ["publish", pkg.directory, "--access", "public", "--provenance"];
  if (pkg.kind === "platform") args.push("--tag", pkg.distTag);
  const result = spawnSync(npmExecutable, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm publish failed for ${pkg.name}@${pkg.version} with exit code ${String(result.status)}.`);
  }
}

function isPublished(name: string, version: string): boolean {
  const result = spawnSync(npmExecutable, ["view", `${name}@${version}`, "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim() === version;

  const error = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found/u.test(error)) return false;
  throw new Error(`Could not check whether ${name}@${version} is published:\n${error.trim()}`);
}
