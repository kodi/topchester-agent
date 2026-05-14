import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  executeToolCall,
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  parsePorcelainStatus,
  parseToolCall,
  runGit,
} from "../src/agent/tools.js";

const execFileAsync = promisify(execFile);

describe("git tools", () => {
  it("parses porcelain status records", () => {
    expect(parsePorcelainStatus(" M src/value.ts\0A  docs/plan.md\0?? notes file.txt\0")).toEqual([
      expect.objectContaining({ path: "src/value.ts", status: "modified", unstaged: true, staged: false }),
      expect.objectContaining({ path: "docs/plan.md", status: "added", unstaged: false, staged: true }),
      expect.objectContaining({ path: "notes file.txt", status: "untracked", untracked: true }),
    ]);
  });

  it("reports non-Git workspaces as a normal status result", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-git-tools-"));
    const result = await gitStatusTool.execute({ workspaceRoot: workspace }, { path: ".", include_untracked: true });

    expect(result).toMatchObject({
      tool: "git_status",
      repoRoot: null,
      clean: true,
      files: [],
      warning: "This workspace is not inside a Git repository.",
    });
  });

  it("handles Git repositories without commits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-git-tools-"));
    await git(workspace, "init");
    await writeFile(join(workspace, "--help.txt"), "looks like a flag\n");

    const status = await gitStatusTool.execute({ workspaceRoot: workspace }, { path: ".", include_untracked: true });
    const log = await gitLogTool.execute({ workspaceRoot: workspace }, { limit: 5 });

    expect(status.hasHead).toBe(false);
    expect(status.files).toEqual([expect.objectContaining({ path: "--help.txt", status: "untracked" })]);
    expect(log).toMatchObject({
      commits: [],
      warning: "Git repository has no commits.",
    });
  });

  it("reports branch metadata and structured staged, unstaged, and untracked files", async () => {
    const workspace = await createCommittedRepo();
    await writeFile(join(workspace, "tracked.txt"), "changed\n");
    await writeFile(join(workspace, "staged.txt"), "staged\n");
    await git(workspace, "add", "--", "staged.txt");
    await writeFile(join(workspace, "notes file.txt"), "untracked\n");

    const result = await gitStatusTool.execute({ workspaceRoot: workspace }, { path: ".", include_untracked: true });

    expect(result.repoRoot).toBe(".");
    expect(result.hasHead).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "modified", unstaged: true }),
        expect.objectContaining({ path: "staged.txt", status: "added", staged: true }),
        expect.objectContaining({ path: "notes file.txt", status: "untracked", untracked: true }),
      ])
    );
    expect(result.content).toContain("?? notes file.txt");
  });

  it("returns staged, unstaged, and untracked diffs with truncation metadata", async () => {
    const workspace = await createCommittedRepo();
    await writeFile(join(workspace, "tracked.txt"), `changed\n${"x".repeat(5000)}\n`);
    await writeFile(join(workspace, "staged.txt"), "staged\n");
    await git(workspace, "add", "--", "staged.txt");
    await writeFile(join(workspace, "untracked.txt"), "untracked\n");

    const result = await gitDiffTool.execute(
      { workspaceRoot: workspace },
      { scope: "all", include_untracked: true, context_lines: 1, max_bytes: 1_000 }
    );

    expect(result.tool).toBe("git_diff");
    expect(result.scope).toBe("all");
    expect(result.fileCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("## staged");
    expect(result.content).toContain("## unstaged");
  });

  it("returns bounded commit log summaries", async () => {
    const workspace = await createCommittedRepo();
    await writeFile(join(workspace, "tracked.txt"), "second\n");
    await git(workspace, "add", "--", "tracked.txt");
    await git(workspace, "commit", "-m", "Second commit");

    const result = await gitLogTool.execute({ workspaceRoot: workspace }, { limit: 1, path: "tracked.txt" });

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]).toMatchObject({ subject: "Second commit", authorName: "Topchester Test" });
    expect(result.content).toContain("Second commit");
  });

  it("stages only explicit paths with matching expected status", async () => {
    const workspace = await createCommittedRepo();
    await writeFile(join(workspace, "tracked.txt"), "changed\n");
    await writeFile(join(workspace, "other.txt"), "other\n");

    const result = await gitAddTool.execute(
      { workspaceRoot: workspace },
      {
        paths: ["tracked.txt"],
        expected_status: [{ path: "tracked.txt", status: "modified" }],
      }
    );

    expect(result.stagedPaths).toEqual(["tracked.txt"]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", staged: true }),
        expect.objectContaining({ path: "other.txt", untracked: true }),
      ])
    );
    await expect(
      gitAddTool.execute(
        { workspaceRoot: workspace },
        { paths: ["."], expected_status: [{ path: ".", status: "modified" }] }
      )
    ).rejects.toThrow("explicit file paths");
  });

  it("commits exactly the expected staged paths and leaves unrelated changes", async () => {
    const workspace = await createCommittedRepo();
    await writeFile(join(workspace, "tracked.txt"), "commit me\n");
    await writeFile(join(workspace, "other.txt"), "leave me\n");
    await gitAddTool.execute(
      { workspaceRoot: workspace },
      { paths: ["tracked.txt"], expected_status: [{ path: "tracked.txt", status: "modified" }] }
    );

    const result = await gitCommitTool.execute(
      { workspaceRoot: workspace },
      { message: "Commit tracked file", expected_staged_paths: ["tracked.txt"] }
    );

    expect(result.commit.subject).toBe("Commit tracked file");
    expect(result.stagedPaths).toEqual(["tracked.txt"]);
    expect(result.remainingFiles).toEqual([expect.objectContaining({ path: "other.txt", untracked: true })]);

    const committedPaths = (await git(workspace, "show", "--name-only", "--pretty=format:", "HEAD"))
      .split("\n")
      .filter(Boolean);
    expect(committedPaths).toEqual(["tracked.txt"]);
    expect(await readFile(join(workspace, "other.txt"), "utf8")).toBe("leave me\n");
  });

  it("rejects workspace escapes and reports missing git clearly", async () => {
    const workspace = await createCommittedRepo();

    await expect(
      gitStatusTool.execute({ workspaceRoot: workspace }, { path: "../outside", include_untracked: true })
    ).rejects.toThrow("inside the workspace");

    const missingGit = await runGit({ cwd: workspace, args: ["status"], pathEnv: "" });

    expect(missingGit.missingGit).toBe(true);
    expect(missingGit.stderr).toContain("git is not available");
  });

  it("executes Git tools through the registry", async () => {
    const workspace = await createCommittedRepo();
    const call = parseToolCall('{"tool":"git_status","args":{"path":".","include_untracked":true}}');

    if (!call) {
      throw new Error("Expected git_status tool call to parse.");
    }

    await expect(executeToolCall(workspace, call)).resolves.toMatchObject({ tool: "git_status", clean: true });
  });
});

async function createCommittedRepo(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "topchester-git-tools-"));
  await git(workspace, "init");
  await git(workspace, "config", "user.name", "Topchester Test");
  await git(workspace, "config", "user.email", "topchester@example.test");
  await writeFile(join(workspace, "tracked.txt"), "initial\n");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "docs", "readme.md"), "# Test\n");
  await git(workspace, "add", "--", "tracked.txt", "docs/readme.md");
  await git(workspace, "commit", "-m", "Initial commit");

  return workspace;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });

  return result.stdout;
}
