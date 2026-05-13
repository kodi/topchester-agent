import { describe, expect, it } from "vitest";
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
