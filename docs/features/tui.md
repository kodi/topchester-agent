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

## Tool visibility

Tool calls appear as compact rows in the thread so you can see what the agent is reading, editing, running, or fetching. Web reads use `web_fetch: <url>` before completion and include the HTTP status plus byte or truncation state afterward, for example:

```text
web_fetch: https://example.com/docs (200, 12,480 bytes)
web_fetch: https://example.com/large-doc (200, truncated)
```

`web_fetch` is for public HTTP(S) pages. It blocks localhost and private-network addresses, strips URL credentials, stops at cross-host redirects, rejects raw bodies over 5 MB, and marks returned text that was capped at 40,000 characters.

## Busy input

While a chat turn is running, the prompt stays editable. Pressing `Enter` on normal text queues it as the next follow-up turn. Queued prompts are local to the running TUI process and are not saved as user messages until they actually start.

Use `/queue <prompt>` to explicitly queue a follow-up. When the agent is idle, `/queue <prompt>` starts immediately like a normal prompt. While the agent is busy, the prompt waits behind the active turn and the TUI shows a compact queued follow-up count.

Use `/steer <prompt>` to send best-effort guidance to the active turn. If the runtime reaches a safe tool-result checkpoint, the guidance is folded into the next model prompt without creating a visible user message. If it is not consumed before the active turn completes, Topchester queues it as a follow-up so the text is not lost.

V0 queues are not persisted across restarts, cannot be edited or removed from a queue-management view, and do not have a configurable busy input mode. Switching sessions with `/new`, `/fork`, or `/restore` drops queued follow-ups and pending steering with a visible notice.

## Startup checks

Interactive startup checks the configured `agent.fast` model and knowledge-base path health. If model config is missing, the TUI points you to `/connect openrouter`, `/model`, or direct config edits.
