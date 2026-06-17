import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeToolCall, isToolErrorResult, parseToolCall } from "../src/agent/tools.js";
import { validateBashPolicy } from "../src/agent/tools/bash-policy.js";
import { validateValidatorCommand } from "../src/agent/tools/command-policy.js";

describe("command policy", () => {
  it("accepts package-script validators for supported package managers", async () => {
    const workspace = await createWorkspace({
      packageManager: "pnpm@11.0.8",
      scripts: {
        "test": "vitest run",
        "lint": "oxlint",
        "typecheck": "tsgo --noEmit",
        "build": "tsdown",
        "check": "pnpm typecheck && pnpm test",
        "format:check": "oxfmt . --check",
        "smoke": "tsx scripts/smoke/run-smoke.ts",
      },
    });

    await expectAllowed(workspace, "pnpm test test/tools.test.ts", "test", ["test", "test/tools.test.ts"]);
    await expectAllowed(workspace, "pnpm run format:check", "format_check", ["run", "format:check"]);
    await expectAllowed(workspace, "npm run lint", "lint", ["run", "lint"]);
    await expectAllowed(workspace, "npm test -- test/tools.test.ts", "test", ["test", "--", "test/tools.test.ts"]);
    await expectAllowed(workspace, "yarn run typecheck", "typecheck", ["run", "typecheck"]);
    await expectAllowed(workspace, "yarn build", "build", ["build"]);
    await expectAllowed(workspace, "bun run smoke -- --fake-api --trials 1", "smoke", [
      "run",
      "smoke",
      "--",
      "--fake-api",
      "--trials",
      "1",
    ]);
  });

  it("allows bun test as a built-in validator without a package script", async () => {
    const workspace = await createWorkspace({ scripts: {} });
    const decision = await validateValidatorCommand(
      { command: "bun test test/example.test.ts" },
      { workspaceRoot: workspace }
    );

    expect(decision).toMatchObject({
      allowed: true,
      plan: {
        executable: "bun",
        args: ["test", "test/example.test.ts"],
        displayCommand: "bun test test/example.test.ts",
        workspaceRelativeCwd: ".",
      },
      policy: {
        kind: "validator",
        validator: "test",
        packageManager: "bun",
      },
    });
  });

  it("accepts direct validator executables", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    for (const [command, validator] of [
      ["vitest run test/tools.test.ts", "test"],
      ["node --test test/node.test.mjs", "test"],
      ["eslint src", "lint"],
      ["biome lint src", "lint"],
      ["tsc --noEmit", "typecheck"],
      ["tsgo --noEmit", "typecheck"],
      ["prettier --check src", "format_check"],
      ["oxfmt . --check", "format_check"],
      ["biome format --check src", "format_check"],
      ["pnpm exec oxfmt . --check", "format_check"],
      ["pnpm exec -- oxfmt . --check", "format_check"],
    ] as const) {
      const decision = await validateValidatorCommand({ command }, { workspaceRoot: workspace });

      expect(decision, command).toMatchObject({
        allowed: true,
        policy: { validator },
      });
    }
  });

  it("rejects risky or unsupported shell-shaped commands", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest run" } });

    for (const command of [
      "pnpm install",
      "npm publish",
      "pnpm test && git status",
      "pnpm test | cat",
      "curl https://example.com",
      "docker compose up",
      "rm -rf dist",
      'bash -lc "pnpm test"',
      "cd packages/app",
      "pnpm test > out.txt",
      "pnpm test *.ts",
    ]) {
      const decision = await validateValidatorCommand({ command }, { workspaceRoot: workspace });

      expect(decision, command).toMatchObject({ allowed: false });
    }
  });

  it("rejects package commands that are not validator scripts", async () => {
    const workspace = await createWorkspace({
      scripts: {
        dev: "vite dev",
        format: "oxfmt .",
      },
    });

    await expectDenied(workspace, "pnpm dev", "not a validator script");
    await expectDenied(workspace, "pnpm format", "not a validator script");
    await expectDenied(workspace, "pnpm missing", "does not define it");
  });

  it("rejects validator hint conflicts", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest run" } });
    const decision = await validateValidatorCommand(
      { command: "pnpm test", validator: "lint" },
      { workspaceRoot: workspace }
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: "command policy classified this as 'test', not 'lint'.",
    });
  });

  it("rejects workdirs outside the workspace", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest run" } });
    const decision = await validateValidatorCommand(
      { command: "pnpm test", workdir: ".." },
      { workspaceRoot: workspace }
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: "command policy rejected path outside the workspace: ..",
    });
  });

  it("finds the nearest package.json at or above the workdir", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest root" } });
    await mkdir(join(workspace, "packages", "app", "src"), { recursive: true });
    await writePackageJson(join(workspace, "packages", "app"), {
      packageManager: "yarn@4.12.0",
      scripts: { lint: "eslint src" },
    });

    const decision = await validateValidatorCommand(
      { command: "yarn lint", workdir: "packages/app/src" },
      { workspaceRoot: workspace }
    );
    const realWorkspace = await realpath(workspace);

    expect(decision).toMatchObject({
      allowed: true,
      policy: {
        validator: "lint",
        packageManager: "yarn",
        packageJsonPath: "packages/app/package.json",
      },
      plan: {
        cwd: join(realWorkspace, "packages", "app", "src"),
        workspaceRelativeCwd: "packages/app/src",
      },
    });
  });

  it("executes run_validator and treats non-zero exits as tool results", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest run" } });
    const bin = await mkdtemp(join(tmpdir(), "topchester-run-validator-bin-"));
    await writeExecutable(
      join(bin, "pnpm"),
      'printf \'CI=%s NO_COLOR=%s args:%s %s %s\\n\' "$CI" "$NO_COLOR" "$1" "$2" "$3"\nprintf \'failed assertion\\n\' >&2\nexit 1'
    );
    const call = parseToolCall(
      '{"tool":"run_validator","args":{"command":"pnpm test -- test/failing.test.ts","validator":"test","timeout_ms":10000}}'
    );

    if (!call) {
      throw new Error("Expected run_validator tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, { pathEnv: bin });

    expect(isToolErrorResult(result)).toBe(false);
    expect(result).toMatchObject({
      tool: "run_validator",
      command: "pnpm test -- test/failing.test.ts",
      cwd: ".",
      exitCode: 1,
      timedOut: false,
      truncated: false,
      stdout: "CI=1 NO_COLOR=1 args:test -- test/failing.test.ts\n",
      stderr: "failed assertion\n",
      policy: {
        kind: "validator",
        validator: "test",
      },
    });
    expect(result.content).toContain("exit_code: 1");
    expect(result.content).toContain("policy: validator test command");
  });

  it("returns a tool error when run_validator cannot find the executable", async () => {
    const workspace = await createWorkspace({ scripts: { test: "vitest run" } });
    const bin = await mkdtemp(join(tmpdir(), "topchester-empty-bin-"));
    const call = parseToolCall('{"tool":"run_validator","args":{"command":"pnpm test","timeout_ms":10000}}');

    if (!call) {
      throw new Error("Expected run_validator tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, { pathEnv: bin });

    expect(result).toMatchObject({
      tool: "run_validator",
      error: "run_validator could not run because 'pnpm' is not available on PATH.",
    });
  });

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

  it("allows shell commands through the terminal benchmark profile", async () => {
    const workspace = await createWorkspace({ scripts: {} });

    await expect(
      validateBashPolicy(
        { command: "rm -rf dist && mkdir -p dist && printf ok > dist/result.txt" },
        { workspaceRoot: workspace, benchmarkProfile: "terminal-bench" }
      )
    ).resolves.toMatchObject({
      allowed: true,
      approvalRequired: false,
      policy: {
        kind: "benchmark_terminal",
        matchedRule: "terminal-bench",
      },
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

  it("uses tighter bash output truncation in terminal-bench profile", async () => {
    const workspace = await createWorkspace({ scripts: {} });
    const bin = await mkdtemp(join(tmpdir(), "topchester-bash-bin-"));
    await writeExecutable(join(bin, "sh"), 'eval "$2"');
    const call = parseToolCall(
      `{"tool":"bash","args":{"command":"i=0; while [ $i -lt 25000 ]; do printf x; i=$((i + 1)); done","timeout_ms":10000}}`
    );

    if (!call) {
      throw new Error("Expected bash tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      pathEnv: bin,
      benchmarkProfile: "terminal-bench",
    });

    expect(isToolErrorResult(result)).toBe(false);
    expect(result).toMatchObject({
      tool: "bash",
      exitCode: 0,
      truncated: true,
      warning: "bash output was truncated.",
    });
    expect(result.content).toContain("[truncated]");
    expect(result.content.length).toBeLessThan(22_000);
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

async function expectAllowed(workspace: string, command: string, validator: string, args: string[]): Promise<void> {
  const decision = await validateValidatorCommand({ command }, { workspaceRoot: workspace });

  expect(decision, command).toMatchObject({
    allowed: true,
    plan: {
      executable: command.split(" ")[0],
      args,
      displayCommand: command,
      workspaceRelativeCwd: ".",
    },
    policy: {
      reason: `validator ${validator} command`,
      kind: "validator",
      validator,
      commands: [command],
    },
  });
}

async function expectDenied(workspace: string, command: string, reason: string): Promise<void> {
  const decision = await validateValidatorCommand({ command }, { workspaceRoot: workspace });

  expect(decision, command).toMatchObject({
    allowed: false,
  });
  expect(decision.reason).toContain(reason);
}

async function createWorkspace(packageJson: {
  packageManager?: string;
  scripts: Record<string, string>;
}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-command-policy-"));
  await writePackageJson(workspace, packageJson);
  return workspace;
}

async function writePackageJson(
  dir: string,
  packageJson: { packageManager?: string; scripts: Record<string, string> }
): Promise<void> {
  await writeFile(join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}
