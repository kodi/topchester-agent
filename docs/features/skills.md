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
