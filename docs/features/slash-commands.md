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
- `/effort` shows the current reasoning effort and accepted values.
- `/effort <none|minimal|low|medium|high|xhigh>` sets reasoning effort for the active model provider.
- `/effort clear` or `/effort default` removes the configured effort so provider defaults apply.
- `/reasoning` is an alias for `/effort`.
- `/new` clears the terminal and starts a fresh project-local session.
- `/fork` clones the current session into a new project-local session and switches to it.
- `/queue <prompt>` queues a follow-up prompt, or starts it immediately when idle.
- `/q <prompt>` is a short alias for `/queue`.
- `/steer <prompt>` sends best-effort guidance to the active turn, falling back to a queued follow-up if it is not consumed.
- `/skills` opens the Skills overlay.
- `/skills list` prints available skills.
- `/skills inspect <name>` shows one `SKILL.md`.
- `/skill <name> [instruction]` activates a skill.
- `/kb status` shows files that are not current in the knowledge base.
- `/kb sync` processes non-clean files into L1 knowledge entries.
- `/kb sync --full` processes all in-scope project files.
- `/kb init` creates Topchester project knowledge folders.
- `/kb reset` deletes the local knowledge base and cache.

`none` is an explicit reasoning effort value. Use `clear` or `default` when you want to remove the config field instead.

`/model`, `/connect`, `/effort`, `/reasoning`, `/new`, `/fork`, `/restore`, `/queue`, `/q`, and `/steer` are TUI-only. In `topchester run`, Topchester prints a short message that says to use the interactive TUI.
