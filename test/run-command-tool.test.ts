import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
