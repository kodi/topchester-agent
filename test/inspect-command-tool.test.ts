import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectWorkspaceCommand } from "../src/agent/tools/inspect-command.js";
import { parseInspectCommand } from "../src/agent/tools/inspect-command-parser.js";
import { inspectCommandArgsSchema, validateInspectCommand } from "../src/agent/tools/inspect-command-policy.js";

describe("inspect_command parser and policy", () => {
  it("defines the inspect_command argument schema", () => {
    expect(inspectCommandArgsSchema.parse({ command: "pwd" })).toEqual({
      command: "pwd",
      workdir: ".",
      timeout_ms: 10_000,
    });
    expect(() => inspectCommandArgsSchema.parse({ command: "" })).toThrow();
    expect(() => inspectCommandArgsSchema.parse({ command: "pwd", timeout_ms: 10 })).toThrow();
  });

  it("parses simple commands, pipelines, and command lists", () => {
    expect(parseInspectCommand("pwd && rg --files docs/plans | head -20")).toEqual({
      command: "pwd && rg --files docs/plans | head -20",
      entries: [
        {
          operator: "start",
          pipeline: {
            commands: [{ executable: "pwd", args: [] }],
          },
        },
        {
          operator: "&&",
          pipeline: {
            commands: [
              { executable: "rg", args: ["--files", "docs/plans"] },
              { executable: "head", args: ["-20"] },
            ],
          },
        },
      ],
    });
  });

  it("parses quoted words without invoking shell expansion", () => {
    expect(parseInspectCommand('rg "function name" src | head -n 5').entries[0]?.pipeline.commands).toEqual([
      { executable: "rg", args: ["function name", "src"] },
      { executable: "head", args: ["-n", "5"] },
    ]);
  });

  it("rejects unsafe shell syntax before policy validation", () => {
    const rejected = [
      "cat package.json > /tmp/out",
      "cat < package.json",
      "cat package.json |& head",
      "echo $HOME",
      "echo $(pwd)",
      "echo `pwd`",
      "(pwd)",
      "pwd &",
      "pwd\nls",
      "ls *.ts",
    ];

    for (const command of rejected) {
      expect(() => parseInspectCommand(command), command).toThrow("inspect_command rejected");
    }
  });

  it("rejects malformed operator placement", () => {
    expect(() => parseInspectCommand("| pwd")).toThrow("operators must appear between commands");
    expect(() => parseInspectCommand("pwd |")).toThrow("pipelines must contain commands on both sides");
    expect(() => parseInspectCommand("pwd &&")).toThrow("operators must appear between commands");
  });

  it("allows initial read-only discovery commands", () => {
    for (const command of [
      "pwd",
      "ls -la docs",
      "rg --files docs/plans | head -20",
      "grep -R -n needle src",
      "find . -maxdepth 2 -type f -print",
      "find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -50",
      "fd runtime src",
      "cat package.json",
      "head -20 docs/cli.md",
      "tail -n 5 docs/cli.md",
      "wc -l package.json",
      "stat package.json",
      "file package.json",
      "du -sh src",
      "git status --short",
      "git log --oneline -5",
      "git diff -- src",
      "git show HEAD -- package.json",
      "git branch --show-current",
      "git rev-parse --show-toplevel",
      "git ls-files docs",
    ]) {
      expect(
        validateInspectCommand({ command, workdir: ".", timeout_ms: 10_000 }, policyContext()),
        command
      ).toMatchObject({
        allowed: true,
      });
    }
  });

  it("rejects commands outside the read-only allowlist", () => {
    for (const command of ["rm -rf dist", "bash -lc pwd", "pnpm test", "node script.js", "curl https://example.com"]) {
      expect(
        validateInspectCommand({ command, workdir: ".", timeout_ms: 10_000 }, policyContext()),
        command
      ).toMatchObject({
        allowed: false,
      });
    }
  });

  it("rejects dangerous command-specific flags", () => {
    for (const command of [
      "find . -delete",
      "find . -exec cat {} ;",
      "rg --pre needle",
      "rg -z needle",
      "fd --exec cat",
      "sed -i 's/a/b/' docs/guide.md",
      "sed 's/a/b/w out.txt' docs/guide.md",
      "sed 's/a/b/e' docs/guide.md",
    ]) {
      expect(
        validateInspectCommand({ command, workdir: ".", timeout_ms: 10_000 }, policyContext()),
        command
      ).toMatchObject({
        allowed: false,
      });
    }
  });

  it("rejects workdirs and path arguments outside the workspace", () => {
    expect(
      validateInspectCommand({ command: "pwd", workdir: "..", timeout_ms: 10_000 }, policyContext())
    ).toMatchObject({
      allowed: false,
      reason: "inspect_command rejected path outside the workspace: ..",
    });
    expect(
      validateInspectCommand({ command: "cat ../package.json", workdir: ".", timeout_ms: 10_000 }, policyContext())
    ).toMatchObject({
      allowed: false,
      reason: "inspect_command rejected path outside the workspace: ../package.json",
    });
  });
});

function policyContext() {
  return {
    workspaceRoot: "/tmp/topchester-workspace",
  };
}

describe("inspect_command execution engine", () => {
  it("runs the built-in pwd from the requested workspace workdir", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    await mkdir(join(workspace, "docs"));

    const result = await inspectWorkspaceCommand(workspace, { command: "pwd", workdir: "docs", timeout_ms: 10_000 });

    expect(result).toMatchObject({
      tool: "inspect_command",
      command: "pwd",
      cwd: "docs",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    expect(result.stdout).toBe(`${await realpath(join(workspace, "docs"))}\n`);
    expect(result.content).toContain("exit_code: 0");
  });

  it("runs allowed executables without a shell and passes pipeline stdout forward", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "rg"), "printf 'one\\ntwo\\nthree\\n'");
    await writeExecutable(
      join(bin, "head"),
      'count=0\nwhile read line && [ $count -lt 2 ]; do\n  echo "$line"\n  count=$((count + 1))\ndone'
    );

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "rg --files docs/plans | head -2", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("one\ntwo\n");
    expect(result.decision.commands).toEqual(["rg --files docs/plans", "head -2"]);
  });

  it("runs the exact repo-orientation pipeline example", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "rg"), "printf 'docs/plans/a.md\\ndocs/plans/b.md\\n'");
    await writeExecutable(
      join(bin, "head"),
      'count=0\nwhile read line && [ $count -lt 20 ]; do\n  echo "$line"\n  count=$((count + 1))\ndone'
    );

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "rg --files docs/plans | head -20", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("docs/plans/a.md\ndocs/plans/b.md\n");
  });

  it("runs the exact repo-orientation command-list example", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "rg"), "printf 'docs/plans/a.md\\n'");
    await writeExecutable(
      join(bin, "head"),
      'count=0\nwhile read line && [ $count -lt 20 ]; do\n  echo "$line"\n  count=$((count + 1))\ndone'
    );

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "pwd && rg --files docs/plans | head -20", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${await realpath(workspace)}\n`);
    expect(result.stdout).toContain("docs/plans/a.md\n");
  });

  it("runs a safe sed filter in an inspect pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "find"), "printf './docs/guide.md\\n./docs/notes.md\\n'");
    await writeExecutable(join(bin, "sed"), "while read line; do printf '%s\\n' \"${line#./}\"; done");
    await writeExecutable(join(bin, "sort"), 'while read line; do echo "$line"; done');
    await writeExecutable(
      join(bin, "head"),
      'count=0\nwhile read line && [ $count -lt 50 ]; do\n  echo "$line"\n  count=$((count + 1))\ndone'
    );

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -50", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("docs/guide.md\ndocs/notes.md\n");
    expect(result.decision.commands).toContain("sed s#^./##");
  });

  it("runs git status --short as read-only repo metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "git"), "printf ' M src/example.ts\\n'");

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "git status --short", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(" M src/example.ts\n");
  });

  it("applies command-list control flow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(join(bin, "grep"), "exit 1");
    await writeExecutable(join(bin, "cat"), "printf 'fallback\\n'");
    await writeFile(join(workspace, "package.json"), "{}\n");

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "grep needle package.json || cat package.json", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fallback\n");
  });

  it("returns a clear warning when an allowed executable is missing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "rg --files", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result).toMatchObject({
      exitCode: 127,
      warning: "inspect_command could not run because 'rg' is not available on PATH.",
    });
    expect(result.stderr).toContain("'rg' is not available");
  });

  it("times out long-running commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeNodeExecutable(join(bin, "rg"), "setTimeout(() => console.log('late'), 2_000);\n");

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "rg needle", workdir: ".", timeout_ms: 100 },
      { pathEnv: bin }
    );

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.warning).toBe("inspect_command timed out.");
  });

  it("truncates large output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-inspect-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-inspect-bin-"));
    await writeExecutable(
      join(bin, "cat"),
      "count=0\nwhile [ $count -lt 2000 ]; do\n  echo line\n  count=$((count + 1))\ndone"
    );
    await writeFile(join(workspace, "package.json"), "{}\n");

    const result = await inspectWorkspaceCommand(
      workspace,
      { command: "cat package.json", workdir: ".", timeout_ms: 10_000 },
      { pathEnv: bin }
    );

    expect(result.truncated).toBe(true);
    expect(result.warning).toBe("inspect_command output was truncated.");
    expect(result.stdout).toContain("[truncated]");
  });
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function writeNodeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${body}`);
  await chmod(path, 0o755);
}
