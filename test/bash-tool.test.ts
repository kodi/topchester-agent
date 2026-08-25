import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { executeToolCall, isToolErrorResult, parseToolCall } from "../src/agent/tools.js";
import { validateBashPolicy } from "../src/agent/tools/bash-policy.js";

describe("bash policy", () => {
  it("allows configured bash prefixes and lets deny rules win", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(
      validateBashPolicy(
        { command: "node scripts/check-fixtures.mjs --quick" },
        {
          workspaceRoot: workspace,
          permissions: {
            allow: ["node scripts/check-fixtures.mjs"],
            allowExact: [],
            deny: [],
          },
        }
      )
    ).resolves.toMatchObject({
      allowed: true,
      policy: {
        kind: "allow_prefix",
        matchedRule: "node scripts/check-fixtures.mjs",
      },
    });

    await expect(
      validateBashPolicy(
        { command: "node scripts/check-fixtures.mjs --quick" },
        {
          workspaceRoot: workspace,
          permissions: {
            allow: ["node scripts/check-fixtures.mjs"],
            allowExact: [],
            deny: ["node scripts/check-fixtures.mjs"],
          },
        }
      )
    ).resolves.toMatchObject({
      allowed: false,
      approvalRequired: false,
      reason:
        "bash policy rejected 'node scripts/check-fixtures.mjs --quick' because it matches deny rule 'node scripts/check-fixtures.mjs'.",
    });
  });

  it("requires approval for unknown bash commands and returns candidates", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(
      validateBashPolicy({ command: "node --version" }, { workspaceRoot: workspace })
    ).resolves.toMatchObject({
      allowed: false,
      approvalRequired: true,
      candidates: {
        exact: ["node --version"],
        prefix: ["node --version", "node"],
      },
      reason: "bash policy requires approval for 'node --version'.",
    });
  });

  it("allows approved bash exact commands without turning them into prefixes", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(
      validateBashPolicy(
        { command: "node --version" },
        {
          workspaceRoot: workspace,
          approvedCommands: ["node --version"],
        }
      )
    ).resolves.toMatchObject({
      allowed: true,
      policy: {
        kind: "approved_exact",
        matchedRule: "node --version",
      },
    });

    await expect(
      validateBashPolicy(
        { command: "node --version --extra" },
        {
          workspaceRoot: workspace,
          approvedCommands: ["node --version"],
        }
      )
    ).resolves.toMatchObject({
      allowed: false,
      approvalRequired: true,
    });
  });

  it("allows configured exact bash rules without turning them into prefixes", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(
      validateBashPolicy(
        { command: "node --version" },
        {
          workspaceRoot: workspace,
          permissions: { allow: [], allowExact: ["node --version"], deny: [] },
        }
      )
    ).resolves.toMatchObject({
      allowed: true,
      policy: {
        kind: "allow_exact",
        matchedRule: "node --version",
      },
    });

    await expect(
      validateBashPolicy(
        { command: "node --version --extra" },
        {
          workspaceRoot: workspace,
          permissions: { allow: [], allowExact: ["node --version"], deny: [] },
        }
      )
    ).resolves.toMatchObject({
      allowed: false,
      approvalRequired: true,
    });
  });

  it("rejects destructive-looking bash commands before approval", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(validateBashPolicy({ command: "rm -rf dist" }, { workspaceRoot: workspace })).resolves.toMatchObject({
      allowed: false,
      approvalRequired: false,
      reason: "bash policy rejected 'rm -rf dist' because it looks destructive: recursive forced deletion.",
    });
  });

  it("executes configured bash commands with shell syntax", async () => {
    const workspace = await createWorkspace({ scripts: {} });
    const bin = await mkdtemp(join(tmpdir(), "topchester-bash-bin-"));
    await writeExecutable(
      join(bin, "sh"),
      "printf 'configured command ran: '; eval \"$2\"\nprintf 'configured stderr\\n' >&2"
    );
    const call = parseToolCall(
      '{"tool":"bash","args":{"command":"printf \\"hi\\\\n\\" | while read line; do printf \\"$line\\"; done","timeout_ms":10000}}'
    );

    if (!call) {
      throw new Error("Expected bash tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      pathEnv: bin,
      config: {
        tools: {
          bash: {
            shell: join(bin, "sh"),
            allow: ["printf"],
            allowExact: [],
            deny: [],
          },
        },
      },
    });

    expect(isToolErrorResult(result)).toBe(false);
    expect(result).toMatchObject({
      tool: "bash",
      command: 'printf "hi\\n" | while read line; do printf "$line"; done',
      exitCode: 0,
      stdout: "configured command ran: hi",
      stderr: "configured stderr\n",
      policy: {
        kind: "allow_prefix",
        matchedRule: "printf",
      },
      workspaceMayHaveChanged: true,
    });
  });

  it("treats non-zero bash exits as ordinary tool results", async () => {
    const workspace = await createWorkspace({ scripts: {} });
    const bin = await mkdtemp(join(tmpdir(), "topchester-bash-bin-"));
    await writeExecutable(join(bin, "sh"), 'eval "$2"');
    const call = parseToolCall('{"tool":"bash","args":{"command":"printf nope >&2; exit 7","timeout_ms":10000}}');

    if (!call) {
      throw new Error("Expected bash tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      pathEnv: bin,
      config: {
        tools: {
          bash: {
            shell: join(bin, "sh"),
            allow: [],
            allowExact: [],
            deny: [],
          },
        },
      },
      bashApprovals: {
        allowExactCommands: ["printf nope >&2; exit 7"],
      },
    });

    expect(isToolErrorResult(result)).toBe(false);
    expect(result).toMatchObject({
      tool: "bash",
      command: "printf nope >&2; exit 7",
      exitCode: 7,
      stderr: "nope",
      policy: {
        kind: "approved_exact",
        matchedRule: "printf nope >&2; exit 7",
      },
    });
  });

  it("returns a tool error for unapproved bash commands", async () => {
    const workspace = await createWorkspace({ scripts: {} });
    const call = parseToolCall('{"tool":"bash","args":{"command":"node scripts/unknown.mjs"}}');

    if (!call) {
      throw new Error("Expected bash tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(result).toMatchObject({
      tool: "bash",
      error: "bash policy requires approval for 'node scripts/unknown.mjs'.",
    });
  });
});

async function createWorkspace(packageJson: {
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-bash-policy-"));
  await writePackageJson(workspace, packageJson);
  return workspace;
}

async function writePackageJson(
  dir: string,
  packageJson: {
    packageManager?: string;
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }
): Promise<void> {
  await writeFile(join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}
