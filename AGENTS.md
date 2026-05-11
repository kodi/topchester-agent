# Topchester Agent

Topchester is a terminal-native TUI coding agent tightly coupled to a committed project knowledge base.

Read these first:

- `docs/ARCHITECTURE.md` — product/runtime architecture, install flow, TUI/runtime boundaries.
- `docs/KNOWLEDGE.md` — mandatory KB architecture, Knowledge Compiler, drift model, storage/API decisions.
- `docs/SESSIONS.md` — project-local session storage and event log decisions.
- `docs/cli.md` — CLI command inventory and behavior notes.

If `AGENTS.override.md` exists, read it after this file for local-only instructions.

Core invariant: Agent and KB are one system. Do not design or implement a normal coding path that bypasses `.agents/topchester-kb/`.

CLI modifications should update `docs/cli.md` in the same change so command behavior stays tracked.

Use PLAIN FOLK SPEAK in user-facing text, even for highly technical product concepts; for example, write something an average developer understands instead of phrasing like `missing canonical KB`.
