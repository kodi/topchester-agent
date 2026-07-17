---
title: Skills
description: Reusable task instructions for Topchester.
section: Features
order: 50
public: true
---

# Skills

Skills are on-demand instructions that teach Topchester a reusable workflow for one kind of task.

They are different from project instructions and generated knowledge:

- `AGENTS.md` controls project behavior all the time.
- `skills/*/SKILL.md` provides reusable workflows that activate only when selected or mentioned.
- `topchester-kb/` and `.agents/topchester-kb-cache/` are generated project knowledge, not skill files.

Topchester ships a built-in `topchester` skill for product help and a focused `topchester-config` skill for configuration work. Workspace and user skills can still shadow built-ins with the same name.

The system prompt tells the agent to load the `topchester` skill for questions about Topchester itself. The skill and its compact linked references ship with the installed package, so product help works in repositories that have no project KB. Explicit `/skill topchester` and `@topchester` activation remain available.

## Activate skills

Use the TUI:

```text
/skills
/skills list
/skills inspect code-review
/skill code-review review this diff
```

You can also mention active skills in normal prompts:

```text
@code-review review this diff
```

Unknown mentions stay normal text. Multiple skill mentions are applied in mention order.

Skills may list files under `references`, `templates`, `scripts`, or `assets`. The agent can read a named linked file with its read-only `skill_read` tool after inspecting or activating the skill. Reads stay inside the selected linked-file group and are capped at 64 KiB.
