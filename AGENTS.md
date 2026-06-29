# Topchester Agent

Topchester is a terminal-native TUI coding agent tightly coupled to a committed project knowledge base.

Read these first:

- `docs/README.md` — public docs entrypoint and source for the website docs build.
- `docs/getting-started/`, `docs/configuration/`, `docs/features/`, `docs/hooks/`, `docs/mcp/`, and `docs/reference/` — public docs pages.
- `docs/reference/cli.md` — CLI command inventory and behavior notes.
- `docs/features/tui.md` — interactive TUI layout, controls, slash commands, and status behavior.
- `docs/features/knowledge-base.md` — user-facing knowledge-base behavior.
- `docs/features/sessions.md` — project-local session storage behavior.
- `docs/ARCHITECTURE.md` — internal product/runtime architecture and TUI/runtime boundaries.
- `docs/KNOWLEDGE.md` — internal KB architecture, Knowledge Compiler, drift model, storage/API decisions.

If `AGENTS.override.md` exists, read it after this file for local-only instructions.

Core invariant: Agent and KB are one system. Do not design or implement a normal coding path that bypasses `.agents/topchester-kb/`.

CLI modifications should update `docs/reference/cli.md` in the same change so command behavior stays tracked. TUI behavior changes should update `docs/features/tui.md` or `docs/features/slash-commands.md`.

## Docs maintenance

`docs/` remains the authoring source for public Topchester docs. The public website renders these files from the sibling `topchester-web` repo, and `topchester-agent` must not commit generated website output.

Public docs deployment is inter-repo: commit and push doc source changes to `topchester-agent` `main` first, then trigger the website deploy from `topchester-web` `main` because Vercel builds that repo and clones `topchester-agent/docs` during the build. There is no GitHub Actions docs deploy workflow to trigger.

To redeploy the public website/docs after a docs-only `topchester-agent` push, run this from the sibling `topchester-web` repo:

```sh
git commit --allow-empty -m "chore: trigger docs deployment"
git push origin main
```

Only use a Vercel dashboard redeploy if the user explicitly asks for it or the empty-commit push is unavailable.

Public docs pages must have frontmatter with `title`, `description`, `section`, `order`, and `public: true`. Public pages live under:

- `docs/getting-started/`
- `docs/configuration/`
- `docs/features/`
- `docs/hooks/`
- `docs/mcp/`
- `docs/reference/`

Internal implementation notes may live under top-level legacy docs or `docs/internals/`, but they should not use `public: true` unless they are intentionally promoted. `docs/plans/` is private implementation handoff material and must not be published in the public docs build.

When behavior changes, update the nearest public docs page and the relevant reference page in the same change. Keep examples exact: config paths, command names, hook event names, MCP field names, and model slot names should match the current implementation.

## Debugging Topchester

When debugging what the agent actually did, inspect the runtime artifacts before guessing from the UI:

- Main log: `.agents/topchester/logs/topchester.log`. Use the newest file and search for `tool_call`, `tool_result`, `tool_result_content`, `model_prompt`, `model_response_text`, `project_instructions_resolved`, and any specific tool name such as `skill_view` or `read_file`.
- Sessions: `.agents/topchester/sessions/<session-id>/metadata.json` and `events.jsonl`. The latest session is usually the newest `metadata.json`; `events.jsonl` gives the ordered user messages, tool calls, task plan updates, assistant replies, and ready/status events.
- To confirm whether a tool result was actually used, find the tool call in `events.jsonl`, then check `topchester.log` for the following `model_prompt` after that tool result. The prompt should include the `Tool result from ...` block that the model saw.
- For tool behavior bugs, compare the compact session events with the raw log. The session proves the high-level order; `topchester.log` shows raw tool result content, model inputs, model outputs, policy decisions, and timing.
- For TUI or session issues, include `docs/features/tui.md`, `docs/features/sessions.md`, and the relevant `src/tui/*` or `src/session/*` files in the investigation.

Use PLAIN FOLK SPEAK in user-facing text, even for highly technical product concepts; for example, write something an average developer understands instead of phrasing like `missing canonical KB`.

Never expose a user's full home directory path in user-facing docs, examples, comments, or responses. Use `~` for home-relative paths.

Use ONLY mise tasks for repo checks and automation; never run pnpm tasks directly. Eg never run `pnpm exec oxfmt` use mise tasks.

Use the fff MCP tools for all file search operations instead of default tools.

## Cursor Cloud specific instructions

Toolchain comes from `mise` (`.mise.toml` pins Node 24 + pnpm 11). `mise` lives at `~/.local/bin/mise` and is activated in `~/.bashrc`, so interactive shells already have Node 24 and the repo tasks on PATH. The startup update script keeps dependencies fresh; you should not need to reinstall anything by hand. Run repo checks via mise tasks (`mise run lint`, `mise run typecheck`, `mise run format-check`, `mise run test`), per the rule above.

Running the agent live needs `OPENROUTER_API_KEY` (the default in `config/example.jsonc`). To exercise the full agent loop end to end without any key, use `mise run smoke` — it runs all scenarios against a deterministic fake model (`--fake-api`). KB output folders (`topchester-kb/`, `.agents/topchester/`) are gitignored, so `kb init`/`kb sync` against the real repo will not show up in `git status`.

Two test caveats specific to running here:

- `mise run test` runs `vitest` across the whole repo, which picks up the `bench/mini-bench/tasks/*/workspace/*.test.ts` fixtures. Those are intentionally-incomplete benchmark task workspaces (missing deps like `express`/`pg`/`react`, or stubbed implementations), so they fail and are NOT part of the product suite. The product suite is the `test/` directory only — run `node_modules/.bin/vitest run --dir test` (this is what `pnpm test` scopes to) to check product tests.
- `test/skills.test.ts > builds skill roots in low-to-high precedence order` fails ONLY because the repo is checked out at `/workspace`, which is itself a git root. That test hardcodes `workspaceRoot: "/workspace/project"`, and `buildSkillRoots` walks up to find `/workspace/.git`, adding an extra workspace scope root and doubling the `workspace-compat` entries (gives 17 roots instead of 11). It passes in any checkout not located under a `/workspace` git root. This is a checkout-location artifact, not a product bug — do not change product code to "fix" it.
