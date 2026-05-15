import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillRoots, getSkillMetadataFromMarkdown, parseSkillMarkdown } from "../src/skills/index.js";

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
});
