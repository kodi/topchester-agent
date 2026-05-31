import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSkillRoots,
  createSkillsService,
  findSkillMentions,
  getSkillMetadataFromMarkdown,
  parseSkillMarkdown,
  resolveSkillCandidates,
  resolveSkillMentionActivations,
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

  it("includes skill roots from the nearest git workspace ancestor", async () => {
    const repo = await mkdtemp(join(tmpdir(), "topchester-skills-repo-"));
    const subdir = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(subdir, { recursive: true });

    const roots = buildSkillRoots({
      workspaceRoot: subdir,
      homeDir: join(repo, "home"),
      packageRoot: join(repo, "package"),
    });
    const neutralRoots = roots.filter((root) => root.source === "workspace-neutral");

    expect(neutralRoots.map((root) => root.root)).toEqual([
      join(repo, ".agents", "skills"),
      join(repo, "packages", ".agents", "skills"),
      join(subdir, ".agents", "skills"),
    ]);
    const neutralPrecedence = neutralRoots.map((root) => root.precedence);
    expect(neutralPrecedence).toEqual([...neutralPrecedence].sort((left, right) => left - right));
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

  it("discovers repo-root skills when launched from a subdirectory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "topchester-skills-repo-"));
    const subdir = join(repo, "src", "feature");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".agents", "skills", "repo-skill"), { recursive: true });
    await mkdir(subdir, { recursive: true });
    await writeFile(
      join(repo, ".agents", "skills", "repo-skill", "SKILL.md"),
      ["---", "name: repo-skill", "description: Repo skill.", "---", "", "# Repo Skill", ""].join("\n")
    );

    const service = createSkillsService({
      workspaceRoot: subdir,
      homeDir: join(repo, "home"),
      packageRoot: join(repo, "package"),
    });

    await expect(service.listSkills()).resolves.toMatchObject({
      active: [
        expect.objectContaining({
          name: "repo-skill",
          source: "workspace-neutral",
          root: join(repo, ".agents", "skills"),
        }),
      ],
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

  it("extracts active skill mentions in mention order", () => {
    const skills = [
      {
        name: "code-review",
        description: "Review code.",
        source: "builtin" as const,
        root: "/repo/skills",
        skillDir: "/repo/skills/code-review",
        skillFile: "/repo/skills/code-review/SKILL.md",
        precedence: 0,
        shadowed: false,
      },
      {
        name: "test_driven.development",
        description: "Write tests first.",
        source: "builtin" as const,
        root: "/repo/skills",
        skillDir: "/repo/skills/test",
        skillFile: "/repo/skills/test/SKILL.md",
        precedence: 0,
        shadowed: false,
      },
    ];

    expect(findSkillMentions("Use @code-review and @missing then @test_driven.development", skills)).toEqual([
      "code-review",
      "test_driven.development",
    ]);
  });

  it("resolves mentioned skills while preserving original text", async () => {
    const root = await mkdtemp(join(tmpdir(), "topchester-skills-mentions-"));
    await mkdir(join(root, "code-review"), { recursive: true });
    await writeFile(join(root, "code-review", "SKILL.md"), "# Code Review\n");
    const service = createSkillsService({
      workspaceRoot: root,
      roots: [{ source: "workspace-neutral", root, precedence: 6 }],
    });

    await expect(resolveSkillMentionActivations("@code-review review this diff", service)).resolves.toMatchObject([
      {
        skill: { name: "code-review" },
        instruction: "@code-review review this diff",
      },
    ]);
    await expect(resolveSkillMentionActivations("@unknown review this diff", service)).resolves.toEqual([]);
  });

  it("discovers built-in package skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-skills-workspace-"));
    const service = createSkillsService({
      workspaceRoot: workspace,
      homeDir: join(workspace, "home"),
      packageRoot: process.cwd(),
    });

    const skills = await service.listSkills();

    expect(skills.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-review",
          source: "builtin",
          description: "Review code for correctness, maintainability, security, and project fit.",
        }),
        expect.objectContaining({
          name: "systematic-debugging",
          source: "builtin",
        }),
        expect.objectContaining({
          name: "test-driven-development",
          source: "builtin",
        }),
        expect.objectContaining({
          name: "plan",
          source: "builtin",
        }),
        expect.objectContaining({
          name: "repo-orientation",
          source: "builtin",
        }),
        expect.objectContaining({
          name: "topchester-config",
          source: "builtin",
          description: expect.stringContaining("Configure Topchester project and user settings."),
        }),
      ])
    );
  });

  it("lets workspace skills override built-in skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-skills-workspace-"));
    await mkdir(join(workspace, ".agents", "skills", "code-review"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "skills", "code-review", "SKILL.md"),
      ["---", "name: code-review", "description: Workspace review.", "---", "", "# Workspace Review", ""].join("\n")
    );

    const service = createSkillsService({
      workspaceRoot: workspace,
      homeDir: join(workspace, "home"),
      packageRoot: process.cwd(),
    });
    const skills = await service.listSkills();

    expect(skills.active.find((skill) => skill.name === "code-review")).toMatchObject({
      source: "workspace-neutral",
      description: "Workspace review.",
    });
    expect(skills.shadowed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "code-review",
          source: "builtin",
          shadowed: true,
        }),
      ])
    );
  });

  it("discovers compatibility paths below .agents and .topchester skills", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-skills-compat-"));
    await mkdir(join(workspace, ".claude", "skills", "release"), { recursive: true });
    await mkdir(join(workspace, ".agents", "skills", "release"), { recursive: true });
    await mkdir(join(workspace, ".topchester", "skills", "release"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "skills", "release", "SKILL.md"),
      ["---", "name: release", "description: Claude release.", "---", "", "# Claude", ""].join("\n")
    );
    await writeFile(
      join(workspace, ".agents", "skills", "release", "SKILL.md"),
      ["---", "name: release", "description: Portable release.", "---", "", "# Portable", ""].join("\n")
    );
    await writeFile(
      join(workspace, ".topchester", "skills", "release", "SKILL.md"),
      ["---", "name: release", "description: Topchester release.", "---", "", "# Topchester", ""].join("\n")
    );

    const service = createSkillsService({
      workspaceRoot: workspace,
      homeDir: join(workspace, "home"),
      packageRoot: workspace,
    });
    const skills = await service.listSkills();

    expect(skills.active.find((skill) => skill.name === "release")).toMatchObject({
      source: "workspace-topchester",
      description: "Topchester release.",
    });
    expect(skills.shadowed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "release",
          source: "workspace-neutral",
          description: "Portable release.",
        }),
        expect.objectContaining({
          name: "release",
          source: "workspace-compat",
          compatibilitySource: "claude",
          description: "Claude release.",
        }),
      ])
    );
  });
});
