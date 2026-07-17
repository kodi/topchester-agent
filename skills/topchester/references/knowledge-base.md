# Knowledge Base

The project KB is mutable workspace knowledge stored under `topchester-kb/`, with generated cache and runtime state below `.agents/`. `topchester kb init`, `sync`, `dry-run`, `status`, and `reset` operate on that project source.

`ignore.paths` affects compiler inventory. Nested `.gitignore` files and built-in safety exclusions also apply. Product help comes from the packaged `topchester` skill; `TOPCHESTER_KB_DIR` only selects the workspace KB.
