# Knowledge Base

The project KB is mutable workspace knowledge stored under `topchester-kb/`, with generated cache and runtime state below `.agents/`. `topchester kb init`, `sync`, `dry-run`, `status`, and `reset` operate on that project source.

`ignore.paths` affects compiler inventory. Nested `.gitignore` files and built-in safety exclusions also apply. Product guidance shipped with Topchester is a separate read-only source; do not mount it through `TOPCHESTER_KB_DIR`.
