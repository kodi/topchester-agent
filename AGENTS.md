# Topchester Agent

## Rules

- Use ASD-STE100 Simplified Technical English for docs, plans, commits, and explanations. Use short, active, declarative sentences. Avoid long noun clusters.
- Use plain folk speech in user-facing text. Prefer wording an average developer understands, such as `KB is missing`, over `missing canonical KB`.
- Never expose a full home-directory path in user-facing docs, examples, comments, or responses. Use `~`.
- If `AGENTS.override.md` exists, read it after this file.
- Use the fff MCP tools for all file searches.
- Use only `mise` tasks for repository checks and automation. Never run `pnpm` tasks directly. `mise run local-ci` must always pass.

## Product and source material

Topchester is a terminal-native TUI coding agent coupled to a committed project knowledge base (KB). The agent and KB are one system. No normal coding path may bypass `.agents/topchester-kb/`.

Read the relevant source before a change:

- `docs/README.md`: public-docs entry point and website source.
- `docs/getting-started/`, `configuration/`, `features/`, `hooks/`, `mcp/`, `reference/`: public docs. These paths are under `docs/`.
- `docs/reference/cli.md`: CLI inventory and behavior.
- `docs/features/tui.md`: TUI layout, controls, slash commands, and status.
- `docs/features/knowledge-base.md`: user-facing KB behavior.
- `docs/features/sessions.md`: project-local session storage.
- `docs/ARCHITECTURE.md`: product/runtime architecture and TUI boundaries.
- `docs/KNOWLEDGE.md`: KB architecture, compiler, drift, storage, and APIs.

Update docs in the same change as behavior:

- CLI change: update `docs/reference/cli.md`.
- TUI change: update `docs/features/tui.md` or `docs/features/slash-commands.md`.
- Other behavior change: update the nearest public page and relevant reference page.
- Keep config paths, commands, hook events, MCP fields, and model slots exact.

## Public docs

`docs/` is the authoring source. The sibling `topchester-web` repo renders it. Do not commit generated website output here.

Public pages live in the six public directories listed above. Each needs frontmatter fields `title`, `description`, `section`, `order`, and `public: true`. Put internal notes in legacy top-level docs or `docs/internals/`. Mark them public only when intentionally promoted. `docs/plans/` is private and must never enter the public build.

Deployment is cross-repository. First commit and push docs to this repo's `main`. Then, from `topchester-web` `main`, trigger the Vercel build, which clones `topchester-agent/docs`:

```sh
git commit --allow-empty -m "chore: trigger docs deployment"
git push origin main
```

There is no GitHub Actions docs-deploy workflow. Use a Vercel dashboard redeploy only if the user asks or the empty-commit push is unavailable.

## Debugging

Inspect runtime artifacts before inferring behavior from the UI:

- Log: `.agents/topchester/logs/topchester.log`. Use the newest log. Search for `tool_call`, `tool_result`, `tool_result_content`, `model_prompt`, `model_response_text`, `project_instructions_resolved`, or a tool name such as `skill_view` or `read_file`.
- Session: `.agents/topchester/sessions/<session-id>/{metadata.json,events.jsonl}`. The newest `metadata.json` usually identifies the latest session. `events.jsonl` records ordered messages, tools, plans, replies, and ready/status events.
- To prove a tool result reached the model, find its call in `events.jsonl`. Then inspect the next `model_prompt` in the log for the matching `Tool result from ...` block.
- For tool bugs, use events for order and the raw log for full results, model I/O, policy decisions, and timing.
- For TUI/session bugs, also inspect `docs/features/{tui,sessions}.md` and relevant `src/{tui,session}/*` files.

## Vite+

Vite+ (`vp`) wraps Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. It is distinct from Vite; use `vp dev` and `vp build`. See `node_modules/vite-plus/docs`, <https://viteplus.dev/guide/>, `vp help`, or `vp <command> --help`.

After pulling remote changes, run `vp install`. Use the applicable `mise` validation tasks; inspect `.mise.toml` and `package.json` for extra tasks. If environment or package-manager behavior fails, run `vp env doctor` and include its output when requesting help.
