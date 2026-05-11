# Topchester Agent

Topchester is a terminal-native TUI coding agent tightly coupled to a committed project knowledge base.

Read these first:

- `docs/ARCHITECTURE.md` — product/runtime architecture, install flow, TUI/runtime boundaries.
- `docs/KNOWLEDGE.md` — mandatory KB architecture, Knowledge Compiler, drift model, storage/API decisions.

Core invariant: Agent and KB are one system. Do not design or implement a normal coding path that bypasses `.agents/topchester-kb/`.
