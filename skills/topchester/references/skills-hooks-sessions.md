# Skills, Hooks, and Sessions

Built-in skills ship with Topchester. User and workspace skills may extend or shadow them. Use `/skills`, `/skills inspect <name>`, `/skill <name> ...`, or `@skill-name` to inspect or activate a skill.

Hooks are configured in `topchester.jsonc`; inspect the current workspace configuration before describing active events or commands.

Sessions are project-local under `.agents/topchester/sessions/`. Use `--resume`, `/restore`, `/fork`, and `/new` for their normal lifecycle.
