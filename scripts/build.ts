/// <reference types="bun" />

import solidPlugin from "@opentui/solid/bun-plugin";
import { chmod, readdir, rm } from "node:fs/promises";

await run([
  "vp",
  "pack",
  "src/bin.ts",
  "src/cli.ts",
  "--format",
  "esm",
  "--dts",
  "--out-dir",
  "dist",
  "--clean",
  "--sourcemap",
]);

for (const file of await readdir("dist")) {
  if (!file.endsWith(".d.mts")) {
    await rm(`dist/${file}`, { force: true });
  }
}

await build("scripts/opentui/cli-entry.ts", "bin.mjs", "#!/usr/bin/env bun");
await build("src/cli.ts", "cli.mjs");
await chmod("dist/bin.mjs", 0o755);

async function build(entrypoint: string, naming: string, banner?: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: "dist",
    naming,
    target: "bun",
    format: "esm",
    packages: "external",
    sourcemap: "external",
    plugins: [solidPlugin],
    ...(banner === undefined ? {} : { banner }),
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Bun build failed for ${entrypoint}`);
  }
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
}
