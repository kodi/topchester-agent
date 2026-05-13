import { isAbsolute, relative, resolve } from "node:path";
import { type InspectCommandPlan, type InspectSimpleCommand, parseInspectCommand } from "./inspect-command-parser.js";
import { z } from "zod";

export const inspectCommandArgsSchema = z.object({
  command: z.string().min(1).max(2_000),
  workdir: z.string().optional().default("."),
  timeout_ms: z.number().int().min(100).max(10_000).optional().default(10_000),
});

export type InspectCommandArgs = z.infer<typeof inspectCommandArgsSchema>;

export interface InspectCommandPolicyContext {
  workspaceRoot: string;
  workdir?: string;
}

export type InspectCommandPolicyDecision =
  | {
      allowed: true;
      reason: string;
      commands: string[];
      plan: InspectCommandPlan;
    }
  | {
      allowed: false;
      reason: string;
      commands: string[];
      plan?: InspectCommandPlan;
    };

const READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "rg",
  "grep",
  "find",
  "fd",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "git",
]);
const PATHLESS_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"]);
const GIT_OPTIONS_WITH_PATH_VALUES = new Set(["--", "--pathspec-from-file"]);
const COMMON_OPTIONS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-c",
  "-e",
  "-m",
  "-n",
  "-S",
  "-s",
  "--after-context",
  "--before-context",
  "--color",
  "--context",
  "--encoding",
  "--glob",
  "--heading",
  "--ignore-file",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--sort",
  "--sort-files",
  "--type",
  "--type-add",
]);
const FIND_OPTIONS_WITH_VALUES = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-type",
  "-maxdepth",
  "-mindepth",
  "-size",
  "-mtime",
  "-newer",
]);
const FD_OPTIONS_WITH_VALUES = new Set(["-e", "-t", "-d", "--extension", "--type", "--max-depth", "--min-depth"]);
const SAFE_PATHLESS_FLAGS = new Set([
  "--",
  "-0",
  "-1",
  "-a",
  "-A",
  "-B",
  "-C",
  "-F",
  "-G",
  "-H",
  "-L",
  "-R",
  "-S",
  "-a",
  "-b",
  "-c",
  "-d",
  "-f",
  "-g",
  "-h",
  "-i",
  "-l",
  "-m",
  "-n",
  "-p",
  "-r",
  "-s",
  "-t",
  "-u",
  "-v",
  "-w",
  "-x",
  "--all",
  "--brief",
  "--bytes",
  "--color",
  "--count",
  "--dereference",
  "--files",
  "--follow",
  "--heading",
  "--hidden",
  "--ignore-case",
  "--line-number",
  "--long",
  "--max-depth",
  "--no-heading",
  "--no-ignore",
  "--null",
  "--oneline",
  "--print",
  "--recursive",
  "--short",
  "--show-current",
  "--show-toplevel",
  "--sort",
  "--word-regexp",
]);
const DENIED_FLAGS = new Set([
  "--hostname-bin",
  "--pre",
  "--pre-glob",
  "--search-zip",
  "-z",
  "-Z",
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprintf",
  "-fprint",
  "--exec",
  "-x",
  "--exec-batch",
  "-X",
]);

export function validateInspectCommand(
  args: InspectCommandArgs,
  context: InspectCommandPolicyContext
): InspectCommandPolicyDecision {
  let plan: InspectCommandPlan;

  try {
    plan = parseInspectCommand(args.command);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "inspect_command rejected this command.",
      commands: [],
    };
  }

  const commands = plan.entries.flatMap((entry) => entry.pipeline.commands.map(formatSimpleCommand));
  const workspace = resolve(context.workspaceRoot);
  const workdir = resolveWorkspacePath(workspace, context.workdir ?? args.workdir);

  if (!workdir.allowed) {
    return { allowed: false, reason: workdir.reason, commands, plan };
  }

  for (const command of plan.entries.flatMap((entry) => entry.pipeline.commands)) {
    const result = validateSimpleCommand(command, { workspaceRoot: workspace, cwd: workdir.path });

    if (!result.allowed) {
      return { allowed: false, reason: result.reason, commands, plan };
    }
  }

  return {
    allowed: true,
    reason: "command uses the inspect_command read-only allowlist",
    commands,
    plan,
  };
}

function validateSimpleCommand(
  command: InspectSimpleCommand,
  context: { workspaceRoot: string; cwd: string }
): { allowed: true } | { allowed: false; reason: string } {
  if (command.executable.includes("/") || command.executable === "cd") {
    return { allowed: false, reason: `inspect_command rejected '${command.executable}' because it is not allowed.` };
  }

  if (!READ_ONLY_COMMANDS.has(command.executable)) {
    return { allowed: false, reason: `inspect_command rejected '${command.executable}' because it is not allowed.` };
  }

  if (command.args.some((arg) => DENIED_FLAGS.has(arg))) {
    const flag = command.args.find((arg) => DENIED_FLAGS.has(arg));
    return { allowed: false, reason: `inspect_command rejected '${command.executable}' because '${flag}' is unsafe.` };
  }

  switch (command.executable) {
    case "pwd":
      return command.args.length === 0
        ? { allowed: true }
        : { allowed: false, reason: "inspect_command rejected 'pwd' because it does not accept path arguments." };
    case "git":
      return validateGitCommand(command, context);
    case "find":
      return validateFindCommand(command, context);
    case "fd":
      return validateGenericCommandArgs(command, context, FD_OPTIONS_WITH_VALUES);
    default:
      return validateGenericCommandArgs(command, context, COMMON_OPTIONS_WITH_VALUES);
  }
}

function validateGitCommand(
  command: InspectSimpleCommand,
  context: { workspaceRoot: string; cwd: string }
): { allowed: true } | { allowed: false; reason: string } {
  const subcommand = command.args.find((arg) => !arg.startsWith("-"));

  if (!subcommand || !PATHLESS_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      allowed: false,
      reason: "inspect_command rejected 'git' because only read-only git subcommands are allowed.",
    };
  }

  if (subcommand === "branch" && command.args.some((arg) => arg !== "branch" && arg !== "--show-current")) {
    return { allowed: false, reason: "inspect_command rejected 'git branch' because only --show-current is allowed." };
  }

  if (subcommand === "rev-parse" && command.args.some((arg) => arg !== "rev-parse" && arg !== "--show-toplevel")) {
    return {
      allowed: false,
      reason: "inspect_command rejected 'git rev-parse' because only --show-toplevel is allowed.",
    };
  }

  return validateGenericCommandArgs(command, context, GIT_OPTIONS_WITH_PATH_VALUES, new Set(["git", subcommand]));
}

function validateFindCommand(
  command: InspectSimpleCommand,
  context: { workspaceRoot: string; cwd: string }
): { allowed: true } | { allowed: false; reason: string } {
  return validateGenericCommandArgs(command, context, FIND_OPTIONS_WITH_VALUES);
}

function validateGenericCommandArgs(
  command: InspectSimpleCommand,
  context: { workspaceRoot: string; cwd: string },
  optionsWithValues: Set<string>,
  knownPathlessWords = new Set<string>()
): { allowed: true } | { allowed: false; reason: string } {
  for (let index = 0; index < command.args.length; index += 1) {
    const arg = command.args[index] ?? "";

    if (knownPathlessWords.has(arg)) {
      continue;
    }

    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }

    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, value] = arg.split("=", 2);

      if (DENIED_FLAGS.has(flag ?? "")) {
        return {
          allowed: false,
          reason: `inspect_command rejected '${command.executable}' because '${flag}' is unsafe.`,
        };
      }

      if (looksLikePath(value ?? "")) {
        const scoped = resolveWorkspacePath(context.workspaceRoot, value ?? "", context.cwd);

        if (!scoped.allowed) {
          return { allowed: false, reason: scoped.reason };
        }
      }

      continue;
    }

    if (arg.startsWith("-")) {
      if (SAFE_PATHLESS_FLAGS.has(arg) || /^-[A-Za-z0-9]+$/.test(arg)) {
        continue;
      }

      return {
        allowed: false,
        reason: `inspect_command rejected '${command.executable}' because '${arg}' is not allowed.`,
      };
    }

    if (!looksLikePath(arg)) {
      continue;
    }

    const scoped = resolveWorkspacePath(context.workspaceRoot, arg, context.cwd);

    if (!scoped.allowed) {
      return { allowed: false, reason: scoped.reason };
    }
  }

  return { allowed: true };
}

function resolveWorkspacePath(
  workspaceRoot: string,
  path: string,
  cwd = workspaceRoot
): { allowed: true; path: string } | { allowed: false; reason: string } {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(workspaceRoot, resolved);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { allowed: false, reason: `inspect_command rejected path outside the workspace: ${path}` };
  }

  return { allowed: true, path: resolved };
}

function looksLikePath(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg.includes("/")
  );
}

function formatSimpleCommand(command: InspectSimpleCommand): string {
  return [command.executable, ...command.args].join(" ");
}
