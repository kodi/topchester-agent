import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TOPCHESTER_PACKAGE_NAME = "topchester-ai";

export type SelfUpdateManager = "npm" | "pnpm" | "bun";

export interface SelfUpdateCommand {
  manager: SelfUpdateManager;
  command: string;
  args: string[];
  display: string;
  target: string;
}

export interface DetectSelfUpdateManagerOptions {
  modulePath?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunSelfUpdateOptions extends DetectSelfUpdateManagerOptions {
  target?: string;
  runner?: SelfUpdateRunner;
}

export interface CheckSelfUpdateOptions extends DetectSelfUpdateManagerOptions {
  currentVersion: string;
  target?: string;
  runner?: SelfUpdateCheckRunner;
}

export interface SelfUpdateCheckResult {
  command: SelfUpdateCommand;
  currentVersion: string;
  availableVersion: string;
  updateAvailable: boolean;
}

export type SelfUpdateRunner = (command: string, args: string[]) => Promise<number | null>;
export type SelfUpdateCheckRunner = (
  command: string,
  args: string[]
) => Promise<{ code: number | null; stdout: string }>;

export function detectSelfUpdateManager(options: DetectSelfUpdateManagerOptions = {}): SelfUpdateManager | undefined {
  const env = options.env ?? process.env;
  const userAgent = env.npm_config_user_agent?.toLowerCase();

  if (userAgent?.startsWith("pnpm/")) {
    return "pnpm";
  }

  if (userAgent?.startsWith("bun/")) {
    return "bun";
  }

  if (userAgent?.startsWith("npm/")) {
    return "npm";
  }

  const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
  const execPath = options.execPath ?? process.execPath;
  const joinedPath = `${modulePath}\0${execPath}`.toLowerCase().replace(/\\/g, "/");

  if (joinedPath.includes("/.pnpm/") || joinedPath.includes("/pnpm/")) {
    return "pnpm";
  }

  if (
    joinedPath.includes("/.bun/") ||
    joinedPath.includes("/bun/") ||
    joinedPath.includes("/install/global/node_modules/")
  ) {
    return "bun";
  }

  if (joinedPath.includes("/node_modules/")) {
    return "npm";
  }

  return undefined;
}

export function createSelfUpdateCommand(
  options: DetectSelfUpdateManagerOptions & { target?: string } = {}
): SelfUpdateCommand | undefined {
  const manager = detectSelfUpdateManager(options);

  if (!manager) {
    return undefined;
  }

  const target = normalizeTarget(options.target);
  const command = manager;
  const args = ["install", "-g", `${TOPCHESTER_PACKAGE_NAME}@${target}`];

  return {
    manager,
    command,
    args,
    display: [command, ...args].map(quoteDisplayArg).join(" "),
    target,
  };
}

export async function runSelfUpdate(options: RunSelfUpdateOptions = {}): Promise<SelfUpdateCommand> {
  const updateCommand = createSelfUpdateCommand(options);

  if (!updateCommand) {
    throw new Error(formatSelfUpdateUnsupportedMessage());
  }

  const runner = options.runner ?? defaultSelfUpdateRunner;
  const code = await runner(updateCommand.command, updateCommand.args);

  if (code !== 0) {
    throw new Error(`Update command failed with exit code ${code ?? "unknown"}: ${updateCommand.display}`);
  }

  return updateCommand;
}

export async function checkSelfUpdate(options: CheckSelfUpdateOptions): Promise<SelfUpdateCheckResult> {
  const updateCommand = createSelfUpdateCommand(options);

  if (!updateCommand) {
    throw new Error(formatSelfUpdateUnsupportedMessage());
  }

  const args = ["view", `${TOPCHESTER_PACKAGE_NAME}@${updateCommand.target}`, "version"];
  const runner = options.runner ?? defaultSelfUpdateCheckRunner;
  const result = await runner(updateCommand.command, args);

  if (result.code !== 0) {
    throw new Error(
      `Update check failed with exit code ${result.code ?? "unknown"}: ${[updateCommand.command, ...args].map(quoteDisplayArg).join(" ")}`
    );
  }

  const availableVersion = result.stdout.trim().split(/\s+/).at(-1) ?? "";
  if (!availableVersion) {
    throw new Error("Update check did not return an available version.");
  }

  return {
    command: updateCommand,
    currentVersion: normalizeTarget(options.currentVersion),
    availableVersion: normalizeTarget(availableVersion),
    updateAvailable: normalizeTarget(options.currentVersion) !== normalizeTarget(availableVersion),
  };
}

export function formatSelfUpdateUnsupportedMessage(): string {
  return [
    "Could not detect whether Topchester was installed with npm, pnpm, or bun.",
    `Update it with the package manager that installed it, for example: npm install -g ${TOPCHESTER_PACKAGE_NAME}@latest`,
  ].join("\n");
}

export function formatSelfUpdateSuccess(command: SelfUpdateCommand): string[] {
  return [`Updated Topchester with ${command.display}.`, "Restart Topchester to use the new version."];
}

export function formatSelfUpdateCheckResult(result: SelfUpdateCheckResult): string[] {
  const lines = [
    `Current Topchester version: ${result.currentVersion}`,
    `Available Topchester version: ${result.availableVersion}`,
  ];

  if (result.updateAvailable) {
    lines.push(`Update available. Run ${result.command.display} to install it.`);
  } else {
    lines.push("Topchester is already up to date.");
  }

  return lines;
}

function normalizeTarget(target = "latest"): string {
  const trimmed = target.trim();

  if (!trimmed) {
    return "latest";
  }

  return trimmed.replace(/^v(?=\d+\.\d+\.\d+(?:[-+]|$))/, "");
}

function quoteDisplayArg(arg: string): string {
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(arg)) {
    return arg;
  }

  return JSON.stringify(arg);
}

function defaultSelfUpdateRunner(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.on("close", resolve);
  });
}

function defaultSelfUpdateCheckRunner(
  command: string,
  args: string[]
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}
