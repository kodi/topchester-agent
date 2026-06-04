# Docs instructions

Public docs are authored in this repo and rendered by `topchester-web`.

Public pages must live in one of these folders and include frontmatter with `public: true`:

- `getting-started/`
- `configuration/`
- `features/`
- `hooks/`
- `mcp/`
- `reference/`

Required frontmatter:

```yaml
---
title: Page title
description: Short page description.
section: Intro
order: 10
public: true
---
```

Keep `docs/plans/`, benchmarks, drafts, and internal design notes out of public navigation. Do not add `public: true` to implementation handoff documents.

`docs/reference/changelog.md` is the source of truth for the public `/changelog/` page. Keep it hand-maintained: add or update date sections with newest days first, group entries under short headings, and link to the relevant commits when useful.

When code behavior changes, update the closest public task page first, then update the relevant reference page if command, config, hook, MCP, or model behavior changed.
