# Skills

Skills are on-demand instructions that teach Topchester a reusable workflow for one kind of task. They are different from `AGENTS.md` and from the generated knowledge base:

- `AGENTS.md` is always-on project guidance.
- `.agents/skills/` contains user-authored workflows that are loaded only when activated.
- `.agents/topchester-kb/` and `topchester-kb/` are generated project knowledge, not skill files.

Topchester lists skill metadata by default and loads full `SKILL.md` content only when a skill is inspected or activated.

## Skill Location

Use this portable project path for skills that should be committed with a repo:

```text
.agents/skills/<skill-name>/SKILL.md
```

Use this path when a workspace needs a Topchester-specific override:

```text
.topchester/skills/<skill-name>/SKILL.md
```

Personal skills can live in either user path:

```text
~/.agents/skills/<skill-name>/SKILL.md
~/.topchester/skills/<skill-name>/SKILL.md
```

Compatibility discovery also checks these workspace paths:

```text
.claude/skills/<skill-name>/SKILL.md
.opencode/skills/<skill-name>/SKILL.md
.gemini/skills/<skill-name>/SKILL.md
.windsurf/skills/<skill-name>/SKILL.md
```

Those compatibility paths work, but `.agents/skills/` is the recommended shared path for new Topchester projects.

## Precedence

When more than one skill has the same name, the higher-precedence skill is active and the others are shadowed:

1. built-in Topchester skills
2. future extension skills
3. `~/.agents/skills/`
4. `~/.topchester/skills/`
5. workspace compatibility paths
6. `.agents/skills/`
7. `.topchester/skills/`
8. future session-preloaded skills

Shadowed skills are still visible in diagnostics and the Skills overlay details.

## Format

Each skill is a directory with a `SKILL.md` file:

```text
.agents/skills/release-checklist/
  SKILL.md
  references/
  templates/
  scripts/
  assets/
```

Only `SKILL.md` is required. Topchester discovers linked files under `references/`, `templates/`, `scripts/`, and `assets/`, but it does not execute scripts in the MVP.

`SKILL.md` can include YAML frontmatter:

```md
---
name: release-checklist
description: Prepare and verify a release.
---

# Release Checklist

## When to Use

Use before publishing a new version.

## Procedure

1. Run local CI.
2. Check changelog.
3. Verify package contents.
4. Tag and publish.

## Verification

Confirm the published package installs successfully.
```

If frontmatter is missing, Topchester derives the name from the directory and uses `No description provided.`.

## Built-In Skills

Topchester ships these read-only built-in skills:

- `code-review`
- `systematic-debugging`
- `test-driven-development`
- `plan`
- `repo-orientation`
- `topchester-config`

To customize a built-in, copy it to a user or workspace skill path with the same name. The copied skill shadows the built-in.

## Activation

Use slash commands in the TUI or `topchester run`:

```text
/skills list
/skills inspect code-review
/skills reload
/skill code-review review this diff
/code-review review this diff
```

The short `/<skill-name>` form works only when it does not conflict with a built-in slash command.

Use an inline mention in a normal prompt:

```text
@code-review review this diff
Use @systematic-debugging on this failing layout
```

Unknown mentions stay normal text. If multiple active skills are mentioned, Topchester activates them in mention order and preserves the original prompt as the user instruction.

## TUI Overlay

Run `/skills` to open the Skills overlay. Run `/skills <query>` to open it filtered by name, description, or source.

The overlay can:

- list active skills with source labels;
- show shadowed skill counts;
- inspect full `SKILL.md` content;
- activate a skill for the next message;
- reload skill discovery;
- close or go back through modal actions.

## Agent Tools

The model can use two read-only tools:

- `skills_list` returns compact active and shadowed skill metadata.
- `skill_view` loads the full `SKILL.md` for one active skill.

Full skill bodies are not injected into the base system prompt.
