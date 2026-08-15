---
title: Topchester Docs
description: Public documentation index for Topchester.
section: Intro
order: 10
public: true
---

# Topchester Docs

Topchester is a terminal-native coding agent. It edits a local workspace, uses a committed project knowledge base, and keeps project policy in files that can be reviewed with the code.

The normal workflow is:

1. Open a project in your terminal.
2. Start `topchester`.
3. Configure a model provider if one is not already configured.
4. Ask the agent to inspect, edit, test, or explain the project.

Topchester is built for repos where future agents should be able to understand what changed. That is why it keeps sessions under `.agents/topchester/sessions/`, project knowledge under `topchester-kb/`, and shared policy in `topchester.jsonc` plus `AGENTS.md`.

Use these docs when you want to install Topchester, configure a model provider, run the TUI, wire project instructions, or extend the agent with hooks, MCP servers, skills, and the knowledge base.

## Start here

- [Quickstart](/docs/getting-started/quickstart/) installs Topchester, configures the smallest useful model setup, and starts the TUI.
- [Config files](/docs/configuration/config-files/) explains where config lives and how overrides work.
- [Models and providers](/docs/configuration/models-and-providers/) shows the model slots and OpenAI-compatible provider shape.
- [CLI commands](/docs/reference/cli/) lists automation commands and behavior.

## What it can use

The agent can read and edit workspace files, search the repo, run approved shell commands for verification and other terminal work, use Git tools, activate skills, call configured local MCP tools, and run lifecycle hooks.

The TUI is the main interface. `topchester run` is available for one-shot prompts and automation.

Implementation plans, benchmarks, and internal design notes stay in this repo, but they are not part of the public docs build unless a page is explicitly promoted with `public: true`.
