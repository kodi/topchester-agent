---
title: Quickstart
description: Install Topchester, configure OpenRouter, and start the TUI.
section: Intro
order: 20
public: true
---

# Quickstart

## Requirements

- Node.js `>=18` and npm for installation. The installed Topchester runtime does not require Bun.
- macOS on Apple Silicon, or glibc Linux on ARM64 or x64.
- An API key for your model provider. The example below uses OpenRouter.

## Install

Install the CLI with your package manager:

```sh
npm install -g topchester-ai
```

Then check the command:

```sh
topchester --version
```

## Choose a model

Set the API key in your shell:

```sh
export OPENROUTER_API_KEY=...
```

Pass a full `provider/model` reference when you start the TUI:

```sh
topchester -m openrouter/google/gemini-3.1-flash-lite
```

This works on a fresh install without model config. Topchester recognizes the
built-in OpenRouter provider, and the selection stays with the session without
editing JSONC. Use `/model openrouter/another-model` to switch directly.

Run `/connect openrouter` when you want to save provider setup and starter model
choices. Edit JSONC when you want a durable default or custom provider.

## Start a project

If you already selected a durable default, start from a project directory with:

```sh
topchester
```

If the project has no knowledge base yet, initialize it:

```text
/kb init
```

Then ask a small first prompt:

```text
Read the README and summarize how to run this project.
```

Topchester stores session logs under `.agents/topchester/sessions/` in the workspace. Do not commit session files.
