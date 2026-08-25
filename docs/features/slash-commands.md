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

- `/model` chooses a model for the current session from saved choices.
- `/model <provider/model>` selects an exact model directly, even if it is not in saved choices.
- `/model all [search]` browses OpenRouter models, adds one to the global choices catalog, and selects it for the current session.
- `/connect` connects a model provider.
- `/effort` shows the current reasoning effort and accepted values.
- `/effort <none|minimal|low|medium|high|xhigh|max>` sets a session override for the active model provider.
- `/effort clear` or `/effort default` removes the session override so the configured effort or provider default applies.
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

The first slash in a direct model reference separates the provider from the full
model ID. For example, `/model openrouter/google/gemini-3.1-flash-lite` selects
provider `openrouter` and model `google/gemini-3.1-flash-lite`. Built-in
OpenRouter and Codex references do not need saved provider config. Custom
providers still do.

`none` is an explicit reasoning effort value. Use `clear` or `default` when you want to remove the session override instead. Model and effort overrides survive resume, restore, and fork; `/new` returns to JSONC defaults.

Type `/effort ` or `/reasoning ` with a trailing space to list all accepted effort values in the suggestion panel. Continue typing to narrow the list, then press `Tab` to complete the selected value.

`/model`, `/connect`, `/effort`, `/reasoning`, `/new`, `/fork`, `/restore`, `/queue`, `/q`, and `/steer` are TUI-only. In `topchester run`, Topchester prints a short message that says to use the interactive TUI.
