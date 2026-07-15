# Configuration

Topchester loads `topchester.jsonc`, then `~/.config/topchester/config.jsonc`, then one selected profile. `--config <path>` selects that profile when present; otherwise `TOPCHESTER_CONFIG` can select it. The two selectors do not stack.

Use top-level `providers` for provider definitions and `models` for model assignments. Project instruction settings live under `instructions`. Inspect the current workspace files before describing local values, and never expose secret provider values.
