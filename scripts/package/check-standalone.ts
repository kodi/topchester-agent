import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCurrentStandaloneTarget } from "../standalone/targets.js";

const run = promisify(execFile);
const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), "topchester-standalone-check-"));
const target = getCurrentStandaloneTarget();
const executable = join(root, "dist", "standalone", target.directoryName, "bin", target.executableName);
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };

try {
  await run("vp", ["run", "build:standalone"], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
  const workspace = join(destination, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const env = {
    ...process.env,
    HOME: destination,
    PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
    TOPCHESTER_CONFIG: "",
    TOPCHESTER_LOG_FILE: "",
    TOPCHESTER_LOG_LEVEL: "silent",
  };

  const version = await run(executable, ["--version"], { env });
  if (version.stdout.trim() !== packageMetadata.version) {
    throw new Error(`Standalone CLI returned ${version.stdout.trim()}, expected ${String(packageMetadata.version)}.`);
  }

  const skills = await run(executable, ["--workspace", workspace, "run", "/skills", "list"], { env });
  if (!skills.stdout.includes("topchester")) {
    throw new Error("Standalone CLI did not load its embedded built-in skills.");
  }

  const bytes = (await stat(executable)).size;
  console.log(`Standalone ${target.id} CLI passes without Bun on PATH (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
} finally {
  await rm(destination, { recursive: true, force: true });
}
