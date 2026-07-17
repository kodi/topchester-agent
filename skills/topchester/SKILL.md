---
name: topchester
description: Explain Topchester commands, configuration, knowledge-base behavior, skills, hooks, sessions, and troubleshooting using packaged product guidance and current workspace facts.
---

# Topchester Product Help

Use this skill for questions about Topchester itself: setup, commands, configuration, models, providers, project knowledge, skills, hooks, sessions, or troubleshooting.

Keep product facts separate from current-repository facts. Read the relevant linked reference when it is needed, then inspect live `topchester.jsonc`, `AGENTS.md`, knowledge status, or other workspace state when the answer depends on local values.

Available references:

- `references/configuration.md`
- `references/knowledge-base.md`
- `references/commands.md`
- `references/skills-hooks-sessions.md`
- `references/troubleshooting.md`

Use `skill_read` only for the reference needed by the question. Treat the current source and tests as authoritative when changing Topchester itself. Do not point `TOPCHESTER_KB_DIR` at the Topchester repository to obtain product help; that variable selects the current workspace's mutable project KB.
