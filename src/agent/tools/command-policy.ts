import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatWorkspaceRelativePath, resolveWorkspaceCwd } from "./process-runner.js";

export type ValidatorKind = "test" | "lint" | "typecheck" | "format_check" | "build" | "check" | "smoke";

export interface CommandPolicyArgs {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  validator?: ValidatorKind;
}

export interface CommandPolicyContext {
  workspaceRoot: string;
  commands?: CommandPolicyConfig;
  approvedCommands?: readonly string[];
}

export interface CommandSpawnPlan {
  executable: string;
  args: string[];
  displayCommand: string;
  cwd: string;
  workspaceRelativeCwd: string;
}

export interface CommandPolicyConfig {
  allow?: readonly string[];
  allowExact?: readonly string[];
  deny?: readonly string[];
}

type CommandPolicyRejectedDecision = {
  allowed: false;
  reason: string;
  commands: string[];
};

export type ValidatorCommandPolicyDecision =
  | {
      allowed: true;
      reason: string;
      plan: CommandSpawnPlan;
      policy: {
        allowed: true;
        reason: string;
        kind: "validator";
        validator: ValidatorKind;
        commands: string[];
        packageManager?: PackageManager;
        packageJsonPath?: string;
      };
    }
  | CommandPolicyRejectedDecision;

export type ConfiguredCommandPolicyDecision =
  | {
      allowed: true;
      reason: string;
      plan: CommandSpawnPlan;
      policy: {
        allowed: true;
        reason: string;
        kind: "configured_command";
        commands: string[];
        matchedRule: string;
      };
    }
  | CommandPolicyRejectedDecision;

export type ApprovedCommandPolicyDecision =
  | {
      allowed: true;
      reason: string;
      plan: CommandSpawnPlan;
      policy: {
        allowed: true;
        reason: string;
        kind: "approved_command";
        commands: string[];
        matchedRule: string;
      };
    }
  | CommandPolicyRejectedDecision;

export type RunCommandPolicyDecision =
  | Exclude<ValidatorCommandPolicyDecision, CommandPolicyRejectedDecision>
  | Exclude<ConfiguredCommandPolicyDecision, CommandPolicyRejectedDecision>
  | Exclude<ApprovedCommandPolicyDecision, CommandPolicyRejectedDecision>
  | CommandPolicyRejectedDecision;

export type CommandPolicyDecision = ValidatorCommandPolicyDecision | ConfiguredCommandPolicyDecision;

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface SimpleCommand {
  executable: string;
  args: string[];
}

interface PackageMetadata {
  path: string;
  dir: string;
  scripts: Record<string, string>;
  packageManager?: PackageManager;
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const DANGEROUS_EXECUTABLES = new Set([
  "bash",
  "bunx",
  "chmod",
  "curl",
  "docker",
  "git",
  "kubectl",
  "mv",
  "npx",
  "pnpx",
  "rm",
  "rmdir",
  "scp",
  "sh",
  "ssh",
  "wget",
]);
const DANGEROUS_PACKAGE_COMMANDS = new Set([
  "add",
  "audit",
  "create",
  "deploy",
  "dlx",
  "install",
  "link",
  "login",
  "outdated",
  "publish",
  "remove",
  "unlink",
  "update",
  "upgrade",
]);
const REJECTED_SYNTAX: Array<[RegExp, string]> = [
  [/\r|\n/, "multiline commands are not allowed"],
  [/[<>]/, "redirects are not allowed"],
  [/\|/, "pipelines are not allowed"],
  [/&/, "background jobs and command lists are not allowed"],
  [/;/, "command lists are not allowed"],
  [/\$\(|\$\{|\$/, "shell expansion is not allowed"],
  [/`/, "command substitution is not allowed"],
  [/[()]/, "subshells are not allowed"],
  [/[{}]/, "command groups are not allowed"],
  [/\*/, "globs are not allowed"],
  [/\?/, "globs are not allowed"],
  [/\[/, "globs are not allowed"],
  [/\]/, "globs are not allowed"],
];

export async function validateValidatorCommand(
  args: CommandPolicyArgs,
  context: CommandPolicyContext
): Promise<ValidatorCommandPolicyDecision> {
  const prepared = await prepareCommandPolicy(args, context);

  if (!prepared.allowed) {
    return prepared;
  }

  const classified = classifyValidator(prepared.command, prepared.metadata);

  if (!classified.allowed) {
    return { allowed: false, reason: classified.reason, commands: [prepared.plan.displayCommand] };
  }

  if (args.validator && args.validator !== classified.validator) {
    return {
      allowed: false,
      reason: `command policy classified this as '${classified.validator}', not '${args.validator}'.`,
      commands: [prepared.plan.displayCommand],
    };
  }

  const policyReason = `validator ${classified.validator} command`;

  return {
    allowed: true,
    reason: policyReason,
    plan: prepared.plan,
    policy: {
      allowed: true,
      reason: policyReason,
      kind: "validator",
      validator: classified.validator,
      commands: [prepared.plan.displayCommand],
      ...(classified.packageManager ? { packageManager: classified.packageManager } : {}),
      ...(prepared.metadata
        ? {
            packageJsonPath:
              relative(prepared.workspaceRoot, prepared.metadata.path) || basename(prepared.metadata.path),
          }
        : {}),
    },
  };
}

export async function validateRunCommandPolicy(
  args: CommandPolicyArgs,
  context: CommandPolicyContext
): Promise<RunCommandPolicyDecision> {
  const prepared = await prepareCommandPolicy(args, context);

  if (!prepared.allowed) {
    return prepared;
  }

  const deniedRule = findMatchingCommandRule(prepared.plan.displayCommand, context.commands?.deny ?? []);

  if (deniedRule) {
    return {
      allowed: false,
      reason: `command policy rejected '${prepared.plan.displayCommand}' because it matches deny rule '${deniedRule}'.`,
      commands: [prepared.plan.displayCommand],
    };
  }

  const classified = classifyValidator(prepared.command, prepared.metadata);

  if (classified.allowed) {
    const policyReason = `validator ${classified.validator} command`;

    return {
      allowed: true,
      reason: policyReason,
      plan: prepared.plan,
      policy: {
        allowed: true,
        reason: policyReason,
        kind: "validator",
        validator: classified.validator,
        commands: [prepared.plan.displayCommand],
        ...(classified.packageManager ? { packageManager: classified.packageManager } : {}),
        ...(prepared.metadata
          ? {
              packageJsonPath:
                relative(prepared.workspaceRoot, prepared.metadata.path) || basename(prepared.metadata.path),
            }
          : {}),
      },
    };
  }

  const allowedExactRule = findExactCommandRule(prepared.plan.displayCommand, context.commands?.allowExact ?? []);

  if (allowedExactRule) {
    const policyReason = `configured exact command allowed by '${allowedExactRule}'`;

    return {
      allowed: true,
      reason: policyReason,
      plan: prepared.plan,
      policy: {
        allowed: true,
        reason: policyReason,
        kind: "configured_command",
        commands: [prepared.plan.displayCommand],
        matchedRule: allowedExactRule,
      },
    };
  }

  const approvedRule = findExactCommandRule(prepared.plan.displayCommand, context.approvedCommands ?? []);

  if (approvedRule) {
    const policyReason = `approved exact command '${approvedRule}'`;

    return {
      allowed: true,
      reason: policyReason,
      plan: prepared.plan,
      policy: {
        allowed: true,
        reason: policyReason,
        kind: "approved_command",
        commands: [prepared.plan.displayCommand],
        matchedRule: approvedRule,
      },
    };
  }

  const allowedRule = findMatchingCommandRule(prepared.plan.displayCommand, context.commands?.allow ?? []);

  if (!allowedRule) {
    return {
      allowed: false,
      reason: `command policy rejected '${prepared.plan.displayCommand}' because it is not a validator or configured command.`,
      commands: [prepared.plan.displayCommand],
    };
  }

  const policyReason = `configured command allowed by '${allowedRule}'`;

  return {
    allowed: true,
    reason: policyReason,
    plan: prepared.plan,
    policy: {
      allowed: true,
      reason: policyReason,
      kind: "configured_command",
      commands: [prepared.plan.displayCommand],
      matchedRule: allowedRule,
    },
  };
}

function findExactCommandRule(command: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => rule.trim() === command);
}

async function prepareCommandPolicy(
  args: CommandPolicyArgs,
  context: CommandPolicyContext
): Promise<
  | {
      allowed: true;
      command: SimpleCommand;
      workspaceRoot: string;
      plan: CommandSpawnPlan;
      metadata: PackageMetadata | undefined;
    }
  | CommandPolicyRejectedDecision
> {
  const parsed = parseSimpleCommand(args.command);

  if (!parsed.allowed) {
    return { allowed: false, reason: parsed.reason, commands: [] };
  }

  const displayCommand = formatCommand(parsed.command);
  const workspaceRoot = await realpath(resolve(context.workspaceRoot));
  const cwd = await resolvePolicyCwd(workspaceRoot, args.workdir ?? ".");

  if (!cwd.allowed) {
    return { allowed: false, reason: cwd.reason, commands: [displayCommand] };
  }

  const executableCheck = validateExecutable(parsed.command.executable, workspaceRoot, cwd.path);

  if (!executableCheck.allowed) {
    return { allowed: false, reason: executableCheck.reason, commands: [displayCommand] };
  }

  if (parsed.command.executable === "cd") {
    return {
      allowed: false,
      reason: "command policy rejected 'cd'; use the workdir field instead.",
      commands: [displayCommand],
    };
  }

  if (DANGEROUS_EXECUTABLES.has(parsed.command.executable)) {
    return {
      allowed: false,
      reason: `command policy rejected '${parsed.command.executable}' because it is not allowed.`,
      commands: [displayCommand],
    };
  }

  return {
    allowed: true,
    command: parsed.command,
    workspaceRoot,
    plan: {
      executable: parsed.command.executable,
      args: parsed.command.args,
      displayCommand,
      cwd: cwd.path,
      workspaceRelativeCwd: formatWorkspaceRelativePath(workspaceRoot, cwd.path),
    },
    metadata: await findNearestPackageMetadata(workspaceRoot, cwd.path),
  };
}

function parseSimpleCommand(
  command: string
): { allowed: true; command: SimpleCommand } | { allowed: false; reason: string } {
  const trimmed = command.trim();

  if (!trimmed) {
    return { allowed: false, reason: "command policy requires a command." };
  }

  for (const [pattern, reason] of REJECTED_SYNTAX) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `command policy rejected this command because ${reason}.` };
    }
  }

  try {
    const words = tokenizeWords(trimmed);

    if (words.length === 0) {
      return { allowed: false, reason: "command policy requires a command." };
    }

    return {
      allowed: true,
      command: {
        executable: words[0] ?? "",
        args: words.slice(1),
      },
    };
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "command policy rejected this command.",
    };
  }
}

function tokenizeWords(command: string): string[] {
  const words: string[] = [];
  let index = 0;

  while (index < command.length) {
    if (/\s/.test(command[index] ?? "")) {
      index += 1;
      continue;
    }

    let value = "";

    while (index < command.length) {
      const char = command[index] ?? "";

      if (/\s/.test(char)) {
        break;
      }

      if (char === "'") {
        const quoted = readQuoted(command, index + 1, "'");
        value += quoted.value;
        index = quoted.nextIndex;
        continue;
      }

      if (char === '"') {
        const quoted = readQuoted(command, index + 1, '"');
        value += quoted.value;
        index = quoted.nextIndex;
        continue;
      }

      value += char;
      index += 1;
    }

    if (!value) {
      throw new Error("command policy rejected this command because empty words are not allowed.");
    }

    words.push(value);
  }

  return words;
}

function readQuoted(command: string, startIndex: number, quote: "'" | '"'): { value: string; nextIndex: number } {
  let index = startIndex;
  let value = "";

  while (index < command.length) {
    const char = command[index] ?? "";

    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }

    value += char;
    index += 1;
  }

  throw new Error("command policy rejected this command because quoted strings must be closed.");
}

function validateExecutable(
  executable: string,
  workspaceRoot: string,
  cwd: string
): { allowed: true } | { allowed: false; reason: string } {
  if (!executable.includes("/") && !isAbsolute(executable)) {
    return { allowed: true };
  }

  const resolved = isAbsolute(executable) ? resolve(executable) : resolve(cwd, executable);
  const relativePath = relative(workspaceRoot, resolved);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { allowed: false, reason: `command policy rejected executable outside the workspace: ${executable}` };
  }

  return { allowed: false, reason: "command policy rejected executable paths; use a PATH executable name." };
}

async function resolvePolicyCwd(
  workspaceRoot: string,
  workdir: string
): Promise<{ allowed: true; path: string } | { allowed: false; reason: string }> {
  try {
    return { allowed: true, path: await resolveWorkspaceCwd(workspaceRoot, workdir, "command policy") };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function findNearestPackageMetadata(workspaceRoot: string, cwd: string): Promise<PackageMetadata | undefined> {
  let current = cwd;

  while (true) {
    const packageJsonPath = join(current, "package.json");

    if (existsSync(packageJsonPath)) {
      return readPackageMetadata(packageJsonPath);
    }

    if (current === workspaceRoot) {
      return undefined;
    }

    const parent = dirname(current);

    if (parent === current || relative(workspaceRoot, parent).startsWith("..")) {
      return undefined;
    }

    current = parent;
  }
}

async function readPackageMetadata(path: string): Promise<PackageMetadata> {
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    scripts?: Record<string, unknown>;
    packageManager?: unknown;
  };
  const scripts = Object.fromEntries(
    Object.entries(raw.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  return {
    path,
    dir: dirname(path),
    scripts,
    packageManager: parsePackageManager(raw.packageManager) ?? (await detectPackageManagerFromLockfiles(dirname(path))),
  };
}

function parsePackageManager(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const name = value.split("@")[0];

  return isPackageManager(name) ? name : undefined;
}

async function detectPackageManagerFromLockfiles(dir: string): Promise<PackageManager | undefined> {
  const checks: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];

  for (const [file, manager] of checks) {
    try {
      await stat(join(dir, file));
      return manager;
    } catch {
      continue;
    }
  }

  return undefined;
}

function classifyValidator(
  command: SimpleCommand,
  metadata: PackageMetadata | undefined
): { allowed: true; validator: ValidatorKind; packageManager?: PackageManager } | { allowed: false; reason: string } {
  if (isPackageManager(command.executable)) {
    return classifyPackageManagerCommand(command, metadata);
  }

  return classifyDirectValidator(command);
}

function classifyPackageManagerCommand(
  command: SimpleCommand,
  metadata: PackageMetadata | undefined
): { allowed: true; validator: ValidatorKind; packageManager: PackageManager } | { allowed: false; reason: string } {
  const manager = command.executable as PackageManager;
  const firstArg = command.args[0];

  if (!firstArg) {
    return {
      allowed: false,
      reason: `command policy rejected '${manager}' because it does not name a validator script.`,
    };
  }

  if (DANGEROUS_PACKAGE_COMMANDS.has(firstArg)) {
    return { allowed: false, reason: `command policy rejected '${manager} ${firstArg}' because it is not allowed.` };
  }

  if (manager === "bun" && firstArg === "test") {
    return { allowed: true, validator: "test", packageManager: manager };
  }

  if (firstArg === "exec") {
    const execCommand = parsePackageExecValidatorCommand(command.args);

    if (!execCommand) {
      return {
        allowed: false,
        reason: `command policy rejected '${manager} exec' because it does not name a validator executable.`,
      };
    }

    const directValidator = classifyDirectValidator(execCommand);

    return directValidator.allowed
      ? { allowed: true, validator: directValidator.validator, packageManager: manager }
      : { allowed: false, reason: directValidator.reason };
  }

  const scriptName = getPackageScriptName(manager, command.args);

  if (!scriptName) {
    return {
      allowed: false,
      reason: `command policy rejected '${manager} ${firstArg}' because it is not a validator script.`,
    };
  }

  if (!metadata) {
    return { allowed: false, reason: "command policy could not find package.json for a package script command." };
  }

  if (!Object.hasOwn(metadata.scripts, scriptName)) {
    return {
      allowed: false,
      reason: `command policy rejected '${scriptName}' because package.json does not define it.`,
    };
  }

  const validator = classifyScriptName(scriptName);

  if (!validator) {
    return { allowed: false, reason: `command policy rejected '${scriptName}' because it is not a validator script.` };
  }

  return { allowed: true, validator, packageManager: manager };
}

function parsePackageExecValidatorCommand(args: string[]): SimpleCommand | undefined {
  let execArgs = args.slice(1);

  if (execArgs[0] === "--") {
    execArgs = execArgs.slice(1);
  }

  const executable = execArgs[0];

  if (!executable || executable.startsWith("-")) {
    return undefined;
  }

  return { executable, args: execArgs.slice(1) };
}

function getPackageScriptName(manager: PackageManager, args: string[]): string | undefined {
  if (args[0] === "run") {
    return args[1];
  }

  if (manager === "npm" && args[0] === "test") {
    return "test";
  }

  if (manager === "pnpm" || manager === "yarn") {
    return args[0];
  }

  return undefined;
}

function classifyDirectValidator(
  command: SimpleCommand
): { allowed: true; validator: ValidatorKind } | { allowed: false; reason: string } {
  switch (command.executable) {
    case "vitest":
    case "jest":
    case "mocha":
      return { allowed: true, validator: "test" };
    case "node":
      return command.args[0] === "--test"
        ? { allowed: true, validator: "test" }
        : { allowed: false, reason: "command policy rejected 'node' because only 'node --test' is a validator." };
    case "eslint":
    case "oxlint":
      return { allowed: true, validator: "lint" };
    case "biome":
      if (command.args[0] === "lint") {
        return { allowed: true, validator: "lint" };
      }
      if (command.args[0] === "format" && command.args.includes("--check")) {
        return { allowed: true, validator: "format_check" };
      }
      break;
    case "tsc":
    case "tsgo":
      return command.args.includes("--noEmit")
        ? { allowed: true, validator: "typecheck" }
        : {
            allowed: false,
            reason: `command policy rejected '${command.executable}' because typecheck must use --noEmit.`,
          };
    case "prettier":
    case "oxfmt":
      return command.args.includes("--check")
        ? { allowed: true, validator: "format_check" }
        : {
            allowed: false,
            reason: `command policy rejected '${command.executable}' because format validators must use --check.`,
          };
  }

  return {
    allowed: false,
    reason: `command policy rejected '${command.executable}' because it is not a known validator.`,
  };
}

function classifyScriptName(scriptName: string): ValidatorKind | undefined {
  if (scriptName === "test" || scriptName.startsWith("test:")) {
    return "test";
  }
  if (scriptName === "lint" || scriptName.startsWith("lint:")) {
    return "lint";
  }
  if (scriptName === "typecheck" || scriptName === "type:check") {
    return "typecheck";
  }
  if (scriptName === "format:check" || scriptName === "format-check") {
    return "format_check";
  }
  if (scriptName === "build" || scriptName.startsWith("build:")) {
    return "build";
  }
  if (scriptName === "check" || scriptName === "ci" || scriptName === "verify") {
    return "check";
  }
  if (scriptName === "smoke" || scriptName.startsWith("smoke:")) {
    return "smoke";
  }

  return undefined;
}

function isPackageManager(value: string | undefined): value is PackageManager {
  return PACKAGE_MANAGERS.has(value ?? "");
}

function findMatchingCommandRule(command: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => command === rule || command.startsWith(`${rule} `));
}

function formatCommand(command: SimpleCommand): string {
  return [command.executable, ...command.args].map(formatCommandWord).join(" ");
}

function formatCommandWord(word: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(word) ? word : JSON.stringify(word);
}
