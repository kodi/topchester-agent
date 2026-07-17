#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const targets = JSON.parse(fs.readFileSync(path.join(packageRoot, "targets.json"), "utf8"));
const platform = os.platform();
const arch = os.arch();
const libc = platform === "linux" ? detectLinuxLibc() : undefined;
const target = targets.find(
  (candidate) =>
    candidate.platform === platform &&
    candidate.arch === arch &&
    (candidate.libc === undefined || candidate.libc === libc)
);
const targetBinary = path.join(packageRoot, "bin", "topchester.exe");

if (!target) {
  fail(
    `No Topchester executable is published for ${platform}-${arch}${libc ? `-${libc}` : ""}. Supported targets: ${targets
      .map((candidate) => candidate.id)
      .join(", ")}.`
  );
}

const installedBinary = resolveInstalledBinary(target);
if (installedBinary) {
  copyBinary(installedBinary, targetBinary);
  if (verifyBinary(targetBinary)) process.exit(0);
}

const downloadedBinary = installMissingPackage(target);
if (downloadedBinary) {
  copyBinary(downloadedBinary, targetBinary);
  if (verifyBinary(targetBinary)) process.exit(0);
}

fail(
  `The ${target.packageName} package was not installed correctly. Reinstall topchester-ai with optional dependencies and install scripts enabled.`
);

function resolveInstalledBinary(candidate) {
  try {
    const packageJsonPath = require.resolve(`${candidate.packageName}/package.json`);
    const binary = path.join(path.dirname(packageJsonPath), "bin", candidate.executableName);
    return fs.existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

function installMissingPackage(candidate) {
  if (!packageJson.optionalDependencies?.[candidate.packageName] || !candidate.packageVersion) return undefined;

  const temporaryPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "topchester-install-"));
  try {
    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--prefix",
        temporaryPrefix,
        `${packageJson.name}@${candidate.packageVersion}`,
      ],
      { stdio: "inherit", windowsHide: true }
    );
    if (result.status !== 0) return undefined;

    const binary = path.join(temporaryPrefix, "node_modules", packageJson.name, "bin", candidate.executableName);
    if (!fs.existsSync(binary)) return undefined;

    const stagedBinary = path.join(packageRoot, "bin", `.topchester-${process.pid}`);
    fs.copyFileSync(binary, stagedBinary);
    fs.chmodSync(stagedBinary, 0o755);
    return stagedBinary;
  } finally {
    fs.rmSync(temporaryPrefix, { recursive: true, force: true });
  }
}

function copyBinary(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { force: true });
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
  fs.chmodSync(destination, 0o755);
  if (path.basename(source).startsWith(".topchester-")) {
    fs.rmSync(source, { force: true });
  }
}

function verifyBinary(binary) {
  const result = childProcess.spawnSync(binary, ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function detectLinuxLibc() {
  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return "glibc";
  } catch {
    // Fall through to the ldd probe.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8", windowsHide: true });
    const output = `${result.stdout || ""}${result.stderr || ""}`.toLowerCase();
    return output.includes("musl") ? "musl" : "glibc";
  } catch {
    return "glibc";
  }
}

function fail(message) {
  console.error(`topchester-ai postinstall: ${message}`);
  process.exit(1);
}
