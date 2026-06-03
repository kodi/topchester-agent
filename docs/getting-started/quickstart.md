---
title: Quickstart
description: Install Topchester, configure OpenRouter, and start the TUI.
section: Intro
order: 20
public: true
---

# Quickstart

## Install

Install the CLI with your package manager:

```sh
npm install -g topchester-ai
```

Then check the command:

```sh
topchester --version
```

## Configure a model

Topchester reads personal model config from `~/.config/topchester/config.jsonc`. On first startup, Topchester creates this file with the smallest OpenRouter setup commented out:

```jsonc
// {
//   "models": {
//     "default": "openrouter/google/gemini-3.1-flash-lite",
//   },
// }
```

Uncomment it when you want to use the default OpenRouter setup:

```jsonc
{
  "models": {
    "default": "openrouter/google/gemini-3.1-flash-lite",
  },
}
```

Set the API key in your shell:

```sh
export OPENROUTER_API_KEY=...
```

You can also start the TUI and run `/connect`, then `/model`, to create and choose a user model config interactively.

## Start a project

From a project directory, run:

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
