import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { formatWorkspaceRelativePath, resolveWorkspaceCwd } from "./process-runner.js";

export const bashPermissionRuleSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const trimmed = value.trim();

    if (trimmed !== value) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must not have leading or trailing whitespace.",
      });
    }

    if (!trimmed) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must name a command.",
      });
    }

    if (/[\r\n]/u.test(trimmed)) {
      context.addIssue({
        code: "custom",
        message: "Bash permission rule must be a single line.",
      });
    }
  });

export const bashPermissionConfigSchema = z
  .object({
    shell: z.string().min(1).optional(),
    allow: z.array(bashPermissionRuleSchema).optional().default([]),
    allowExact: z.array(bashPermissionRuleSchema).optional().default([]),
    deny: z.array(bashPermissionRuleSchema).optional().default([]),
  })
  .strict();

export type BashPermissionConfig = z.infer<typeof bashPermissionConfigSchema>;

export interface BashPolicyArgs {
  command: string;
  workdir?: string;
}

export interface BashPolicyContext {
  workspaceRoot: string;
  permissions?: BashPermissionConfig;
  approvedCommands?: readonly string[];
}

export interface BashApprovalCandidates {
  exact: string[];
  prefix: string[];
}

export type BashPermissionDecision =
  | {
      allowed: true;
      reason: string;
      command: string;
      cwd: string;
      workspaceRelativeCwd: string;
      shell: string;
      approvalRequired: false;
      policy: {
        allowed: true;
        reason: string;
        kind: "allow_exact" | "allow_prefix" | "approved_exact";
        commands: string[];
        matchedRule: string;
      };
    }
  | {
      allowed: false;
      reason: string;
      command: string;
      commands: string[];
      approvalRequired: boolean;
      candidates?: BashApprovalCandidates;
    };

const COMMON_PREFIX_EXECUTABLES = new Set(["pnpm", "npm", "yarn", "bun", "node", "mise"]);
const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/u, "recursive forced deletion"],
  [/\bgit\s+reset\s+--hard\b/u, "hard git reset"],
  [/\bgit\s+clean\s+-[^\s]*f/u, "forced git clean"],
  [/\bsudo\b/u, "privileged command execution"],
  [/\bdd\s+/u, "raw disk writing"],
  [/\bmkfs(?:\.\w+)?\b/u, "filesystem formatting"],
];

export async function validateBashPolicy(
  args: BashPolicyArgs,
  context: BashPolicyContext
): Promise<BashPermissionDecision> {
  const command = args.command.trim();

  if (!command) {
    return reject(command, "bash policy requires a command.", false);
  }

  if (command.includes("\u0000")) {
    return reject(command, "bash policy rejected this command because null bytes are not allowed.", false);
  }

  const realWorkspaceRoot = await realpath(resolve(context.workspaceRoot));
  const cwd = await resolveBashCwd(realWorkspaceRoot, args.workdir ?? ".");

  if (!cwd.allowed) {
    return reject(command, cwd.reason, false);
  }

  const deniedRule = findMatchingBashRule(command, context.permissions?.deny ?? []);

  if (deniedRule) {
    return reject(command, `bash policy rejected '${command}' because it matches deny rule '${deniedRule}'.`, false);
  }

  const destructive = getDestructiveReason(command);

  if (destructive) {
    return reject(command, `bash policy rejected '${command}' because it looks destructive: ${destructive}.`, false);
  }

  const shell = resolveBashShell(context.permissions?.shell);
  const allowedExactRule = findExactBashRule(command, context.permissions?.allowExact ?? []);

  if (allowedExactRule) {
    return allow(command, cwd.path, realWorkspaceRoot, shell, "allow_exact", allowedExactRule);
  }

  const approvedRule = findExactBashRule(command, context.approvedCommands ?? []);

  if (approvedRule) {
    return allow(command, cwd.path, realWorkspaceRoot, shell, "approved_exact", approvedRule);
  }

  const allowedPrefixRule = findMatchingBashRule(command, context.permissions?.allow ?? []);

  if (allowedPrefixRule) {
    return allow(command, cwd.path, realWorkspaceRoot, shell, "allow_prefix", allowedPrefixRule);
  }

  return {
    allowed: false,
    reason: `bash policy requires approval for '${command}'.`,
    command,
    commands: [command],
    approvalRequired: true,
    candidates: getBashApprovalCandidates(command),
  };
}

export function isBashApprovalRequired(decision: BashPermissionDecision): boolean {
  return !decision.allowed && decision.approvalRequired;
}

export function getBashApprovalCandidates(command: string): BashApprovalCandidates {
  const normalized = command.trim();
  const prefix = getCommonPrefixCandidates(normalized);

  return {
    exact: normalized ? [normalized] : [],
    prefix,
  };
}

function allow(
  command: string,
  cwd: string,
  workspaceRoot: string,
  shell: string,
  kind: "allow_exact" | "allow_prefix" | "approved_exact",
  matchedRule: string
): Extract<BashPermissionDecision, { allowed: true }> {
  const reason =
    kind === "allow_exact"
      ? `bash exact command allowed by '${matchedRule}'`
      : kind === "allow_prefix"
        ? `bash command allowed by prefix '${matchedRule}'`
        : `bash exact command approved by '${matchedRule}'`;

  return {
    allowed: true,
    reason,
    command,
    cwd,
    workspaceRelativeCwd: formatWorkspaceRelativePath(workspaceRoot, cwd),
    shell,
    approvalRequired: false,
    policy: {
      allowed: true,
      reason,
      kind,
      commands: [command],
      matchedRule,
    },
  };
}

function reject(
  command: string,
  reason: string,
  approvalRequired: boolean
): Extract<BashPermissionDecision, { allowed: false }> {
  return {
    allowed: false,
    reason,
    command,
    commands: command ? [command] : [],
    approvalRequired,
    ...(approvalRequired ? { candidates: getBashApprovalCandidates(command) } : {}),
  };
}

function findExactBashRule(command: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => rule.trim() === command);
}

function findMatchingBashRule(command: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => command === rule.trim() || command.startsWith(`${rule.trim()} `));
}

function getDestructiveReason(command: string): string | undefined {
  return DESTRUCTIVE_PATTERNS.find(([pattern]) => pattern.test(command))?.[1];
}

function getCommonPrefixCandidates(command: string): string[] {
  const firstWords = command.match(/^\s*([A-Za-z0-9_./:-]+)(?:\s+([A-Za-z0-9_./:-]+))?/u);
  const executable = firstWords?.[1];
  const second = firstWords?.[2];

  if (!executable) {
    return [];
  }

  const executableName = basename(executable);

  if (!COMMON_PREFIX_EXECUTABLES.has(executableName)) {
    return [];
  }

  return second ? [`${executable} ${second}`, executable] : [executable];
}

function resolveBashShell(configuredShell: string | undefined): string {
  if (configuredShell?.trim()) {
    return configuredShell.trim();
  }

  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }

  return process.env.SHELL?.trim() || "/bin/bash";
}

async function resolveBashCwd(
  workspaceRoot: string,
  workdir: string
): Promise<{ allowed: true; path: string } | { allowed: false; reason: string }> {
  try {
    const resolved = await resolveWorkspaceCwd(workspaceRoot, workdir, "bash");
    return { allowed: true, path: resolved };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
