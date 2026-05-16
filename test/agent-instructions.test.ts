import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProjectInstructions,
  isProjectInstructionPath,
  resolveProjectInstructions,
  type ProjectInstructionSource,
} from "../src/agent/instructions.js";

describe("project instruction resolver", () => {
  it("loads root instructions and formats the prompt block", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "AGENTS.md"), "Use plain language.\n");

    const context = await resolveProjectInstructions(workspace);

    expect(context.sourceKeys).toEqual(["AGENTS.md"]);
    expect(context.sources).toMatchObject([
      {
        relativePath: "AGENTS.md",
        scopePath: ".",
        depth: 0,
        bytes: Buffer.byteLength("Use plain language.\n"),
        truncated: false,
        content: "Use plain language.\n",
      },
    ]);
    expect(context.formatted).toContain("# AGENTS.md instructions");
    expect(context.formatted).toContain("Direct system, developer, and user instructions override these files.");
    expect(context.formatted).toContain("## AGENTS.md for .");
    expect(context.formatted).toContain("Scope: .");
    expect(context.formatted).toContain("<INSTRUCTIONS>\nUse plain language.\n\n</INSTRUCTIONS>");
  });

  it("loads AGENTS.md before AGENTS.override.md at the same scope", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "AGENTS.md"), "Root instruction.\n");
    await writeFile(join(workspace, "AGENTS.override.md"), "Override instruction.\n");

    const context = await resolveProjectInstructions(workspace);

    expect(context.sourceKeys).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    expect(context.formatted.indexOf("Root instruction.")).toBeLessThan(
      context.formatted.indexOf("Override instruction.")
    );
    expect(context.formatted).toContain("Root instruction.");
    expect(context.formatted).toContain("Override instruction.");
  });

  it("preserves root-to-target ordering for nested instructions", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src", "agent"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Source rule.\n");
    await writeFile(join(workspace, "src", "agent", "AGENTS.override.md"), "Agent override.\n");

    const context = await resolveProjectInstructions(workspace, { targetPath: "src/agent/runtime.ts" });

    expect(context.sourceKeys).toEqual(["AGENTS.md", "src/AGENTS.md", "src/agent/AGENTS.override.md"]);
    expect(context.sources.map((source) => source.scopePath)).toEqual([".", "src", "src/agent"]);
    expect(context.sources.map((source) => source.depth)).toEqual([0, 1, 2]);
    expect(context.formatted.indexOf("Root rule.")).toBeLessThan(context.formatted.indexOf("Source rule."));
    expect(context.formatted.indexOf("Source rule.")).toBeLessThan(context.formatted.indexOf("Agent override."));
  });

  it("uses the target itself as the scope when the target is a directory", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "docs", "AGENTS.md"), "Docs rule.\n");

    const context = await resolveProjectInstructions(workspace, { targetPath: "docs", targetIsDirectory: true });

    expect(context.sourceKeys).toEqual(["AGENTS.md", "docs/AGENTS.md"]);
  });

  it("rejects targets outside the workspace", async () => {
    const workspace = await createWorkspace();

    await expect(resolveProjectInstructions(workspace, { targetPath: "../outside.txt" })).rejects.toThrow(
      "inside the workspace"
    );
  });

  it("ignores empty instruction files and falls through to the next candidate", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "AGENTS.override.md"), "  \n");
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");

    const context = await resolveProjectInstructions(workspace);

    expect(context.sourceKeys).toEqual(["AGENTS.md"]);
    expect(context.formatted).toContain("Root rule.");
  });

  it("skips unreadable instruction files without failing the whole resolver", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Nested rule.\n");
    await chmod(join(workspace, "src", "AGENTS.md"), 0o000);

    try {
      const context = await resolveProjectInstructions(workspace, { targetPath: "src/file.ts" });

      expect(context.sourceKeys).toEqual(["AGENTS.md"]);
      expect(context.formatted).not.toContain("Nested rule.");
    } finally {
      await chmod(join(workspace, "src", "AGENTS.md"), 0o600);
    }
  });

  it("applies per-file and total byte budgets with truncation markers", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "abcdef");
    await writeFile(join(workspace, "src", "AGENTS.md"), "ghijkl");

    const context = await resolveProjectInstructions(workspace, {
      targetPath: "src/file.ts",
      maxBytesPerFile: 4,
      maxTotalBytes: 7,
    });

    expect(context.truncated).toBe(true);
    expect(context.sources.map((source) => source.content)).toEqual(["abcd", "ghi"]);
    expect(context.sources.map((source) => source.truncated)).toEqual([true, true]);
    expect(context.formatted).toContain("Instruction file truncated");
  });

  it("uses configured filenames and fallback filenames", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "CLAUDE.md"), "Root fallback.\n");
    await writeFile(join(workspace, "src", "AGENT.md"), "Nested custom.\n");
    await writeFile(join(workspace, "src", "CLAUDE.md"), "Nested fallback.\n");

    const context = await resolveProjectInstructions(workspace, {
      targetPath: "src/file.ts",
      files: ["AGENT.md"],
      fallbackFiles: ["CLAUDE.md"],
    });

    expect(context.sourceKeys).toEqual(["CLAUDE.md", "src/AGENT.md", "src/CLAUDE.md"]);
    expect(context.formatted).toContain("Root fallback.");
    expect(context.formatted).toContain("Nested custom.");
    expect(context.formatted).toContain("Nested fallback.");
  });

  it("can disable project instruction loading", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");

    const context = await resolveProjectInstructions(workspace, { enabled: false });

    expect(context.sourceKeys).toEqual([]);
    expect(isProjectInstructionPath(workspace, "AGENTS.md")).toBe(true);
  });

  it("returns an empty formatted block when no instruction files are present", async () => {
    const workspace = await createWorkspace();

    const context = await resolveProjectInstructions(workspace);

    expect(context).toEqual({
      sources: [],
      formatted: "",
      sourceKeys: [],
      truncated: false,
    });
  });

  it("identifies protected instruction paths inside the workspace", async () => {
    const workspace = await createWorkspace();

    expect(isProjectInstructionPath(workspace, "AGENTS.md")).toBe(true);
    expect(isProjectInstructionPath(workspace, "src/AGENTS.override.md")).toBe(true);
    expect(isProjectInstructionPath(workspace, "src/notes.md")).toBe(false);
    expect(isProjectInstructionPath(workspace, "../AGENTS.md")).toBe(false);
  });
});

describe("project instruction formatter", () => {
  it("formats provided sources without resolving the filesystem", () => {
    const formatted = formatProjectInstructions([
      {
        path: "/workspace/AGENTS.md",
        relativePath: "AGENTS.md",
        scopePath: ".",
        depth: 0,
        bytes: 11,
        truncated: false,
        content: "Root rule.\n",
      },
      {
        path: "/workspace/src/AGENTS.md",
        relativePath: "src/AGENTS.md",
        scopePath: "src",
        depth: 1,
        bytes: 13,
        truncated: true,
        content: "Nested rule.",
      },
    ] satisfies ProjectInstructionSource[]);

    expect(formatted).toContain("## AGENTS.md for .");
    expect(formatted).toContain("## AGENTS.md for src");
    expect(formatted).toContain("Nested rule.\n\n[Instruction file truncated");
  });
});

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "topchester-agent-instructions-"));
}
