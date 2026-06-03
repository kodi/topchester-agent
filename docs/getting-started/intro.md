---
title: What is Topchester?
description: A short introduction to the terminal-native Topchester coding agent.
section: Intro
order: 15
public: true
---

# What is Topchester?

Topchester is a terminal-native coding agent. It edits a local workspace, uses a committed project knowledge base, and keeps project policy in files that can be reviewed with the code.

The normal workflow is:

1. Open a project in your terminal.
2. Start `topchester`.
3. Configure a model provider if one is not already configured.
4. Ask the agent to inspect, edit, test, or explain the project.

Topchester is built for repos where future agents should be able to understand what changed. That is why it keeps sessions under `.agents/topchester/sessions/`, project knowledge under `topchester-kb/`, and shared policy in `topchester.jsonc` plus `AGENTS.md`.

## What it can use

The agent can read and edit workspace files, search the repo, run approved shell commands, run strict validators, use Git tools, activate skills, call configured local MCP tools, and run lifecycle hooks.

The TUI is the main interface. `topchester run` is available for one-shot prompts and automation.
