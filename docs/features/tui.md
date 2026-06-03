---
title: TUI
description: Use the interactive terminal UI, prompt box, status line, and startup checks.
section: Features
order: 10
public: true
---

# TUI

Run `topchester` in an interactive terminal to open the chat-style TUI.

```sh
topchester
topchester --resume latest
```

The TUI has a thread area, a visible plan block when the agent is working through a plan, a prompt box, and a status line.

The status line shows readiness, folder name, active model, provider, and knowledge-base state:

```text
ready · my-project · qwen/qwen3-coder [openrouter] · kb: ready
```

## Everyday controls

- `Enter` sends a message.
- `Shift+Enter` adds a new prompt line in terminals that report it distinctly.
- `/` opens slash command suggestions.
- `Up` and `Down` browse prompt history or slash suggestions, depending on focus.
- `Tab` completes the selected slash suggestion.
- `Ctrl-C` once asks for confirmation; `Ctrl-C` again exits.

Topchester renders inline instead of using the terminal alternate screen, so terminal scrollback remains available.

## Startup checks

Interactive startup checks the configured `agent.fast` model and knowledge-base path health. If model config is missing, the TUI points you to `/connect openrouter`, `/model`, or direct config edits.
