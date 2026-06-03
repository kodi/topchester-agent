---
title: Slash commands
description: Built-in TUI commands for models, skills, sessions, and the knowledge base.
section: Features
order: 20
public: true
---

# Slash commands

Slash commands run inside the TUI before a message is sent to the model.

Common commands:

- `/model` chooses from configured model choices.
- `/model all [search]` browses OpenRouter models and adds one to choices.
- `/connect` connects a model provider.
- `/new` clears the terminal and starts a fresh project-local session.
- `/skills` opens the Skills overlay.
- `/skills list` prints available skills.
- `/skills inspect <name>` shows one `SKILL.md`.
- `/skill <name> [instruction]` activates a skill.
- `/kb status` shows files that are not current in the knowledge base.
- `/kb sync` processes non-clean files into L1 knowledge entries.
- `/kb sync --full` processes all in-scope project files.
- `/kb init` creates Topchester project knowledge folders.
- `/kb reset` deletes the local knowledge base and cache.

`/model` and `/connect` are TUI-only. In `topchester run`, Topchester prints a short message that says to use the interactive TUI.
