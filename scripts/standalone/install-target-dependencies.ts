import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STANDALONE_TARGETS } from "./targets.js";

const root = process.cwd();
const dependencyRoot = join(root, "dist", "standalone-dependencies");
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const openTuiVersion = packageMetadata.dependencies?.["@opentui/core"];

if (!openTuiVersion || !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(openTuiVersion)) {
  throw new Error("@opentui/core must use an exact version before preparing standalone targets.");
}

await rm(dependencyRoot, { recursive: true, force: true });
await mkdir(dependencyRoot, { recursive: true });
await writeFile(join(dependencyRoot, "package.json"), '{"name":"topchester-standalone-dependencies","private":true}\n');

const packageNames = [...new Set(STANDALONE_TARGETS.map((target) => target.openTuiPackageName))];
await run("bun", [
  "install",
  "--os=*",
  "--cpu=*",
  "--ignore-scripts",
  "--no-save",
  ...packageNames.map((name) => `${name}@${openTuiVersion}`),
]);

for (const packageName of packageNames) {
  const relativePackagePath = packageName.split("/");
  const source = join(dependencyRoot, "node_modules", ...relativePackagePath);
  const destination = join(root, "node_modules", ...relativePackagePath);
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(source, destination, { recursive: true, force: true, preserveTimestamps: true });
}

console.log(`Prepared ${packageNames.length} OpenTUI native libraries for standalone cross-compilation.`);

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: dependencyRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}.`));
    });
  });
}
