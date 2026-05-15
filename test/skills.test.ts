import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSkillRoots,
  createSkillsService,
  getSkillMetadataFromMarkdown,
  parseSkillMarkdown,
  resolveSkillCandidates,
  scanSkillRoot,
} from "../src/skills/index.js";

describe("skills", () => {
  it("parses YAML frontmatter and body from SKILL.md", () => {
    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: code-review",
        "description: Review code for correctness.",
        "extra:",
        "  enabled: true",
        "---",
        "",
        "# Code Review",
        "",
        "Use this when reviewing code.",
        "",
      ].join("\n")
    );

    expect(parsed.frontmatter).toMatchObject({
      name: "code-review",
      description: "Review code for correctness.",
      extra: { enabled: true },
    });
    expect(parsed.body).toBe("# Code Review\n\nUse this when reviewing code.\n");
  });

  it("tolerates missing frontmatter", () => {
    expect(parseSkillMarkdown("# Release\n\nDo the release.\n")).toEqual({
      body: "# Release\n\nDo the release.\n",
    });
    expect(getSkillMetadataFromMarkdown("# Release\n", "release-checklist")).toEqual({
      name: "release-checklist",
      description: "No description provided.",
      frontmatter: undefined,
      body: "# Release\n",
    });
  });

  it("builds skill roots in low-to-high precedence order", () => {
    const roots = buildSkillRoots({
      workspaceRoot: "/workspace/project",
      homeDir: "/home/user",
      packageRoot: "/package/topchester",
      sessionRoots: ["/tmp/session-skills"],
    });

    expect(roots.map((root) => root.source)).toEqual([
      "builtin",
      "extension",
      "user-neutral",
      "user-topchester",
      "workspace-compat",
      "workspace-compat",
      "workspace-compat",
      "workspace-compat",
      "workspace-neutral",
      "workspace-topchester",
      "session",
    ]);
    expect(roots.map((root) => root.precedence)).toEqual(roots.map((_, index) => index));
    expect(roots[0]).toMatchObject({ root: "/package/topchester/skills", readonly: true });
    expect(roots[4]).toMatchObject({
      root: join("/workspace/project", ".claude", "skills"),
      compatibilitySource: "claude",
    });
    expect(roots.at(-1)).toMatchObject({ source: "session", root: "/tmp/session-skills" });
  });

  it("scans skill directories with SKILL.md and linked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-skills-root-"));
    await mkdir(join(root, "code-review", "references"), { recursive: true });
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(
      join(root, "code-review", "SKILL.md"),
      ["---", "name: code-review", "description: Review code.", "---", "", "# Code Review", ""].join("\n")
    );
    await writeFile(join(root, "code-review", "references", "rubric.md"), "# Rubric\n");
    await writeFile(join(root, "ignored", "README.md"), "# No skill\n");

    const candidates = await scanSkillRoot({
      source: "workspace-neutral",
      root,
      precedence: 6,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "code-review",
      description: "Review code.",
      source: "workspace-neutral",
      precedence: 6,
      shadowed: false,
      linkedFiles: {
        references: ["rubric.md"],
        templates: [],
        scripts: [],
        assets: [],
      },
    });
  });

  it("resolves duplicate skills to the highest-precedence candidate", async () => {
    const builtin = await mkdtemp(join(tmpdir(), "topchester-skills-builtin-"));
    const workspace = await mkdtemp(join(tmpdir(), "topchester-skills-workspace-"));
    await mkdir(join(builtin, "code-review"), { recursive: true });
    await mkdir(join(workspace, "code-review"), { recursive: true });
    await writeFile(
      join(builtin, "code-review", "SKILL.md"),
      ["---", "name: code-review", "description: Built-in review.", "---", "", "# Built In", ""].join("\n")
    );
    await writeFile(
      join(workspace, "code-review", "SKILL.md"),
      ["---", "name: code-review", "description: Workspace review.", "---", "", "# Workspace", ""].join("\n")
    );

    const candidates = [
      ...(await scanSkillRoot({ source: "builtin", root: builtin, precedence: 0, readonly: true })),
      ...(await scanSkillRoot({ source: "workspace-neutral", root: workspace, precedence: 6 })),
    ];
    const resolved = resolveSkillCandidates(candidates);

    expect(resolved.active).toHaveLength(1);
    expect(resolved.active[0]).toMatchObject({
      name: "code-review",
      description: "Workspace review.",
      source: "workspace-neutral",
      shadowed: false,
    });
    expect(resolved.shadowed).toHaveLength(1);
    expect(resolved.shadowed[0]).toMatchObject({
      name: "code-review",
      description: "Built-in review.",
      source: "builtin",
      shadowed: true,
      shadowedBy: join(workspace, "code-review"),
    });
  });

  it("lists and views active skills through the cached service", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-skills-service-"));
    await mkdir(join(root, "debugging"), { recursive: true });
    await writeFile(
      join(root, "debugging", "SKILL.md"),
      ["---", "name: debugging", "description: Debug carefully.", "---", "", "# Debugging", ""].join("\n")
    );

    const service = createSkillsService({
      workspaceRoot: root,
      roots: [{ source: "workspace-neutral", root, precedence: 6 }],
    });

    await expect(service.listSkills()).resolves.toMatchObject({
      active: [{ name: "debugging", description: "Debug carefully." }],
      shadowed: [],
    });
    await expect(service.viewSkill("debugging")).resolves.toMatchObject({
      name: "debugging",
      content: expect.stringContaining("# Debugging"),
      linkedFiles: {
        references: [],
        templates: [],
        scripts: [],
        assets: [],
      },
    });
  });

  it("rejects linked skill file path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-skills-service-"));
    await mkdir(join(root, "review", "references"), { recursive: true });
    await writeFile(join(root, "review", "SKILL.md"), "# Review\n");
    await writeFile(join(root, "secret.md"), "secret\n");

    const service = createSkillsService({
      workspaceRoot: root,
      roots: [{ source: "workspace-neutral", root, precedence: 6 }],
    });

    await expect(service.readLinkedFile("review", "references", "../secret.md")).rejects.toThrow(
      "Linked skill file path stays outside references."
    );
  });
});
