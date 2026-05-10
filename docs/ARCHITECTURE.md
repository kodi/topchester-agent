# Architecture

Status: Draft

## Product Direction

We are building a very specific TUI coding agent.

The product is not intended to be a generic chatbot wrapper. It should be a focused terminal-native coding agent with a deliberately constrained workflow, opinionated interaction model, and implementation choices that support fast, precise software-development loops.

## TUI Foundation

We will use the TUI package from the `earendil-works/pi` repository:

- Source: https://github.com/earendil-works/pi/tree/main/packages/tui

This is the chosen foundation for the terminal UI layer. Architecture and implementation decisions should assume this TUI package unless we explicitly replace it later.

## High-Level Architecture

The agent should be organized around a small set of clear responsibilities:

1. TUI shell
   - Owns rendering, keyboard input, navigation, layout, and terminal interaction.
   - Built on `earendil-works/pi/packages/tui`.

2. Agent runtime
   - Owns the coding-agent loop: receiving user intent, planning actions, executing tools, and returning results.
   - Should remain decoupled from the TUI rendering layer.

3. Tool execution layer
   - Owns filesystem, shell, git, search, and other coding actions.
   - Should expose a narrow, auditable interface to the agent runtime.

4. Workspace model
   - Tracks the current project, files, diffs, tasks, and relevant context.
   - Should be explicit rather than inferred implicitly from UI state.

5. State and persistence
   - Stores session state, configuration, and durable project metadata as needed.
   - Should keep transient UI state separate from agent/workspace state.

## Initial Design Principles

- Terminal-first: the core experience should feel native in a terminal, not like a web app squeezed into a terminal.
- Specific over generic: avoid adding broad assistant features until the coding-agent workflow requires them.
- Clear separation of concerns: UI, runtime, tools, and workspace state should be independently testable.
- Auditable actions: commands, file edits, and git operations should be visible and reviewable.
- Fast feedback loops: the interface should make it easy to inspect plans, diffs, test output, and agent decisions.
- Minimal hidden state: important state should be represented in the workspace model or persisted deliberately.

## Open Questions

- What is the exact target workflow for the coding agent?
- Which language/runtime will the app use?
- What is the package name and public API shape of `earendil-works/pi/packages/tui`?
- What tools will the agent be allowed to execute?
- How much autonomy should the agent have before requiring user approval?
- How should sessions, plans, diffs, and command history be persisted?

## Near-Term Next Steps

1. Inspect `earendil-works/pi/packages/tui` to understand its API, examples, layout primitives, input model, and rendering lifecycle.
2. Define the first concrete coding-agent workflow end-to-end.
3. Sketch the runtime boundaries between TUI, agent loop, tools, and workspace state.
4. Choose the initial project structure and testing strategy.
