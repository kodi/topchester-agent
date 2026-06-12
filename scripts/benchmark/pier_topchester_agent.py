from __future__ import annotations

import json
import shlex
import time
from pathlib import Path, PurePosixPath
from typing import Any

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.agents.network import allowlist_from_urls, collect_url_values
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier.models.trial.paths import EnvironmentPaths


class TopchesterAgent(BaseInstalledAgent):
    """Pier custom agent for running Topchester with an explicit KB prewarm step."""

    _REMOTE_TOPCHESTER_HOME = PurePosixPath("/tmp/topchester-home")
    _REMOTE_CONFIG_PATH = PurePosixPath("/tmp/topchester-config.jsonc")
    _REMOTE_INSTRUCTION_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "instruction.md")
    _REMOTE_EVENTS_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-events.jsonl")
    _REMOTE_RUN_STDOUT_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-run.stdout")
    _REMOTE_KB_INIT_STDOUT_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-kb-init.stdout")
    _REMOTE_KB_INVENTORY_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-kb-inventory.txt")
    _REMOTE_KB_SYNC_STDOUT_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-kb-sync.stdout")
    _REMOTE_LOG_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester.log")
    _REMOTE_METADATA_PATH = PurePosixPath(EnvironmentPaths.agent_dir / "topchester-metadata.json")

    def __init__(
        self,
        *args: Any,
        npm_package: str = "topchester-ai",
        node_version: str = "24",
        topchester_binary: str = "topchester",
        config_jsonc: str | None = None,
        config_jsonc_file: str | None = None,
        kb_model: str | None = None,
        tool_protocol: str | None = None,
        openrouter_tool_routing: str | None = None,
        kb_ignore_mode: str = "code",
        kb_max_files: int = 150,
        benchmark_prompt: bool = True,
        plan_todo_mode: str = "compact",
        max_plan_todo_updates: int | None = 3,
        prewarm_kb: bool = True,
        prewarm_full: bool = True,
        dangerously_auto_approve_flag: str = "--dangerously-auto-approve",
        **kwargs: Any,
    ):
        self._npm_package = npm_package
        self._node_version = node_version
        self._topchester_binary = topchester_binary
        self._config_jsonc = config_jsonc
        if config_jsonc_file:
            self._config_jsonc = Path(config_jsonc_file).read_text()
        self._kb_model = kb_model
        self._tool_protocol = tool_protocol
        self._openrouter_tool_routing = openrouter_tool_routing
        self._kb_ignore_mode = kb_ignore_mode
        self._kb_max_files = kb_max_files
        self._benchmark_prompt = benchmark_prompt
        self._plan_todo_mode = plan_todo_mode
        self._max_plan_todo_updates = max_plan_todo_updates
        self._prewarm_kb = prewarm_kb
        self._prewarm_full = prewarm_full
        self._dangerously_auto_approve_flag = dangerously_auto_approve_flag
        self._run_metadata: dict[str, Any] = {}
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "topchester"

    def get_version_command(self) -> str | None:
        return (
            "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
            f"{shlex.quote(self._topchester_binary)} --version"
        )

    def install_spec(self) -> AgentInstallSpec:
        version_spec = f"@{self._version}" if self._version else "@latest"
        package_spec = f"{self._npm_package}{version_spec}"

        root_run = (
            "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
            "  apk add --no-cache bash curl git npm nodejs ripgrep; "
            "elif command -v apt-get >/dev/null 2>&1; then "
            "  apt-get update && apt-get install -y bash curl git ripgrep; "
            "elif command -v yum >/dev/null 2>&1; then "
            "  yum install -y bash curl git ripgrep; "
            "else "
            "  echo 'Warning: no known package manager found' >&2; "
            "fi"
        )

        agent_run = (
            "set -euo pipefail; "
            "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
            "if ! command -v nvm >/dev/null 2>&1; then "
            "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash; "
            "  export NVM_DIR=\"$HOME/.nvm\"; "
            "  . \"$NVM_DIR/nvm.sh\"; "
            "fi; "
            f"nvm install {shlex.quote(self._node_version)}; "
            f"nvm alias default {shlex.quote(self._node_version)}; "
            f"npm install -g {shlex.quote(package_spec)}; "
            f"{shlex.quote(self._topchester_binary)} --version"
        )

        symlink_run = (
            "if [ -s /root/.nvm/nvm.sh ]; then . /root/.nvm/nvm.sh; fi; "
            "if [ -s /home/agent/.nvm/nvm.sh ]; then . /home/agent/.nvm/nvm.sh; fi; "
            "for bin in node npm npx topchester; do "
            "  BIN_PATH=\"$(command -v \"$bin\" 2>/dev/null || true)\"; "
            "  if [ -n \"$BIN_PATH\" ] && [ \"$BIN_PATH\" != \"/usr/local/bin/$bin\" ]; then "
            "    ln -sf \"$BIN_PATH\" \"/usr/local/bin/$bin\"; "
            "  fi; "
            "done"
        )

        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(user="root", env={"DEBIAN_FRONTEND": "noninteractive"}, run=root_run),
                InstallStep(user="agent", run=agent_run),
                InstallStep(user="root", run=symlink_run),
            ],
        )

    def network_allowlist(self) -> NetworkAllowlist:
        urls: list[str] = []
        if self._config_jsonc:
            try:
                urls.extend(collect_url_values(json.loads(_strip_jsonc_comments(self._config_jsonc))))
            except Exception:
                pass
        return allowlist_from_urls(
            urls,
            default_domains=[
                "registry.npmjs.org",
                "nodejs.org",
                "raw.githubusercontent.com",
                "github.com",
                "api.openai.com",
                "openrouter.ai",
            ],
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        topchester_instruction = _benchmark_instruction(instruction) if self._benchmark_prompt else instruction

        await self.exec_as_agent(
            environment,
            command=f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}",
        )
        await self.exec_as_agent(
            environment,
            command=_write_file_command(self._REMOTE_CONFIG_PATH, self._resolve_config_jsonc()),
            env=self._topchester_env(),
        )
        await self.exec_as_agent(
            environment,
            command=_write_file_command(self._REMOTE_INSTRUCTION_PATH, topchester_instruction),
            env=self._topchester_env(),
        )

        kb_init_duration_ms: int | None = None
        kb_sync_duration_ms: int | None = None

        try:
            if self._prewarm_kb:
                started = time.monotonic()
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"{self._base_topchester_command()} kb init "
                        f"2>&1 | tee {shlex.quote(self._REMOTE_KB_INIT_STDOUT_PATH.as_posix())}"
                    ),
                    env=self._topchester_env(),
                    cwd="/app",
                )
                kb_init_duration_ms = int((time.monotonic() - started) * 1000)

                await self.exec_as_agent(
                    environment,
                    command=self._kb_inventory_guard_command(),
                    env=self._topchester_env(),
                    cwd="/app",
                )

                started = time.monotonic()
                sync_args = " --full" if self._prewarm_full else ""
                await self.exec_as_agent(
                    environment,
                    command=self._kb_sync_command(sync_args),
                    env=self._topchester_env(),
                    cwd="/app",
                )
                kb_sync_duration_ms = int((time.monotonic() - started) * 1000)

            started = time.monotonic()
            await self.exec_as_agent(
                environment,
                command=(
                    f"{self._base_topchester_command()} run "
                    f"{shlex.quote(self._dangerously_auto_approve_flag)} "
                    f"--json --output-json {shlex.quote(self._REMOTE_EVENTS_PATH.as_posix())} "
                    f"\"$(cat {shlex.quote(self._REMOTE_INSTRUCTION_PATH.as_posix())})\" "
                    f"2>&1 | tee {shlex.quote(self._REMOTE_RUN_STDOUT_PATH.as_posix())}"
                ),
                env=self._topchester_env(),
                cwd="/app",
            )
            run_duration_ms = int((time.monotonic() - started) * 1000)
            self._run_metadata = {
                "kb_prewarm": {
                    "enabled": self._prewarm_kb,
                    "full": self._prewarm_full,
                    "init_duration_ms": kb_init_duration_ms,
                    "sync_duration_ms": kb_sync_duration_ms,
                    "max_files": self._kb_max_files,
                },
                "prompt": {"benchmark_wrapper": self._benchmark_prompt},
                "plan_todo": {
                    "mode": self._plan_todo_mode,
                    "max_updates_per_turn": self._max_plan_todo_updates,
                },
                "models": {
                    "agent": self.model_name,
                    "kb_summarize": self._kb_model or self.model_name,
                },
                "agent_run": {"duration_ms": run_duration_ms},
            }
        finally:
            await self._collect_topchester_artifacts(environment)

    def populate_context_post_run(self, context: AgentContext) -> None:
        log_events = _read_jsonl(self.logs_dir / "topchester.log")
        run_events = _read_jsonl(self.logs_dir / "topchester-events.jsonl")
        usage = _sum_model_response_usage(log_events)
        n_agent_steps = sum(1 for event in run_events if event.get("type") == "tool_call")

        context.n_input_tokens = _none_if_zero(usage["input_tokens"])
        context.n_cache_tokens = _none_if_zero(usage["cache_tokens"])
        context.n_output_tokens = _none_if_zero(usage["output_tokens"])
        context.cost_usd = _none_if_zero_float(usage["cost_usd"])
        context.n_agent_steps = n_agent_steps or None
        context.metadata = {
            "topchester": {
                **self._run_metadata,
                "usage_source": "topchester.log model_response events",
                "usage_note": (
                    "Top-level Pier usage currently reflects model_response events emitted "
                    "by Topchester. If KB sync does not emit model_response events, its "
                    "token/cost split will be absent from these totals."
                ),
                "log_event_count": len(log_events),
                "run_event_count": len(run_events),
                "model_response_usage": usage,
            }
        }

        try:
            (self.logs_dir / "topchester-metadata.json").write_text(json.dumps(context.metadata, indent=2) + "\n")
        except OSError:
            pass

    def _resolve_config_jsonc(self) -> str:
        if self._config_jsonc:
            return self._config_jsonc
        model = self.model_name or "openrouter/qwen/qwen3-coder"
        kb_model = self._kb_model or model
        provider_config: dict[str, Any] = {}
        if self._tool_protocol or self._openrouter_tool_routing:
            provider_config = {
                "providers": {
                    "default": "openrouter",
                    "openrouter": {
                        "type": "openai-compatible",
                        "baseURL": "https://openrouter.ai/api/v1",
                        "apiKeyEnv": "OPENROUTER_API_KEY",
                        "supportsStructuredOutputs": True,
                        **({"toolProtocol": self._tool_protocol} if self._tool_protocol else {}),
                        **(
                            {"openRouterToolRouting": self._openrouter_tool_routing}
                            if self._openrouter_tool_routing
                            else {}
                        ),
                    },
                }
            }
        return json.dumps(
            {
                "$schema": "https://topchester.com/schemas/config.v1.json",
                "models": {
                    "default": model,
                    "kb.summarize": kb_model,
                },
                **provider_config,
                **({"ignore": {"paths": CODE_ONLY_KB_IGNORE_PATHS}} if self._kb_ignore_mode == "code" else {}),
            },
            indent=2,
        )

    def _topchester_env(self) -> dict[str, str]:
        env = self.build_process_env(
            {
                "NODE_USE_ENV_PROXY": "1",
                "TOPCHESTER_CONFIG": "",
                "TOPCHESTER_LOG_LEVEL": "debug",
                "TOPCHESTER_HOME": self._REMOTE_TOPCHESTER_HOME.as_posix(),
                "TOPCHESTER_PLAN_TODO_MODE": self._plan_todo_mode,
                "TOPCHESTER_REQUIRE_FINISH_TASK": "1",
            }
        )
        if self._max_plan_todo_updates is not None:
            env["TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN"] = str(self._max_plan_todo_updates)
        if self._get_env("OPENROUTER_API_KEY"):
            env["OPENROUTER_API_KEY"] = self._get_env("OPENROUTER_API_KEY") or ""
        if self._get_env("OPENAI_API_KEY"):
            env["OPENAI_API_KEY"] = self._get_env("OPENAI_API_KEY") or ""
        return env

    def _base_topchester_command(self) -> str:
        parts = [
            self._topchester_binary,
            "--workspace",
            "/app",
            "--config",
            self._REMOTE_CONFIG_PATH.as_posix(),
        ]
        return " ".join(shlex.quote(part) for part in parts if part)

    def _kb_sync_command(self, sync_args: str) -> str:
        output_path = self._REMOTE_KB_SYNC_STDOUT_PATH.as_posix()
        # Topchester returns 2 for partial KB sync. For benchmark prewarm, keep
        # the successful entries and continue so the task can still run.
        inner = (
            "set -o pipefail; "
            f"{self._base_topchester_command()} kb sync{sync_args} "
            f"2>&1 | tee {shlex.quote(output_path)}; "
            'status="${PIPESTATUS[0]}"; '
            'if [ "$status" -eq 2 ]; then exit 0; fi; '
            'exit "$status"'
        )
        return f"bash -lc {shlex.quote(inner)}"

    def _kb_inventory_guard_command(self) -> str:
        output_path = shlex.quote(self._REMOTE_KB_INVENTORY_PATH.as_posix())
        max_files = max(0, int(self._kb_max_files))
        inner = f"""
set -euo pipefail
node <<'TOPCHESTER_KB_INVENTORY'
const fs = require("node:fs");
const path = require("node:path");

const root = "/app";
const outputPath = {json.dumps(self._REMOTE_KB_INVENTORY_PATH.as_posix())};
const config = JSON.parse(fs.readFileSync({json.dumps(self._REMOTE_CONFIG_PATH.as_posix())}, "utf8"));
const rules = config.ignore?.paths ?? [];
const hardSkippedDirs = new Set([".git", "node_modules", "topchester-kb"]);

function escapeRegExp(value) {{
  return value.replace(/[|\\\\{{}}()[\\]^$+?.]/g, "\\\\$&");
}}

function expandBraces(pattern) {{
  return pattern.replace(/\\{{([^{{}}]+)\\}}/g, (_, body) => `(${{body.split(",").map(escapeRegExp).join("|")}})`);
}}

function globToRegExp(pattern) {{
  const expanded = expandBraces(pattern);
  let source = "";
  for (let i = 0; i < expanded.length; i += 1) {{
    const char = expanded[i];
    const next = expanded[i + 1];
    if (char === "*" && next === "*") {{
      const after = expanded[i + 2];
      if (after === "/") {{
        source += "(?:.*/)?";
        i += 2;
      }} else {{
        source += ".*";
        i += 1;
      }}
    }} else if (char === "*") {{
      source += "[^/]*";
    }} else if (char === "?") {{
      source += "[^/]";
    }} else if (char === "(" || char === ")" || char === "|") {{
      source += char;
    }} else {{
      source += escapeRegExp(char);
    }}
  }}
  return new RegExp(`^${{source}}$`);
}}

const compiledRules = rules.map((raw) => {{
  const negated = raw.startsWith("!");
  return {{ negated, regex: globToRegExp(negated ? raw.slice(1) : raw) }};
}});

function isIgnored(relativePath) {{
  let ignored = false;
  for (const rule of compiledRules) {{
    if (rule.regex.test(relativePath)) ignored = !rule.negated;
  }}
  return ignored;
}}

function walk(dir, out) {{
  for (const entry of fs.readdirSync(dir, {{ withFileTypes: true }})) {{
    if (entry.isDirectory() && hardSkippedDirs.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {{
      walk(absolute, out);
    }} else if (entry.isFile() && !isIgnored(relative)) {{
      out.push(relative);
    }}
  }}
}}

const files = [];
walk(root, files);
files.sort();
fs.writeFileSync(outputPath, `${{files.join("\\n")}}${{files.length ? "\\n" : ""}}`);
TOPCHESTER_KB_INVENTORY
count="$(wc -l < {output_path} | tr -d ' ')"
echo "KB inventory files: $count"
if [ {max_files} -gt 0 ] && [ "$count" -gt {max_files} ]; then
  echo "KB inventory exceeds kb_max_files={max_files}; refusing prewarm. Set --ak kb_max_files=0 to disable." >&2
  sed -n '1,120p' {output_path} >&2
  exit 42
fi
"""
        return f"bash -lc {shlex.quote(inner)}"

    async def _collect_topchester_artifacts(self, environment: BaseEnvironment) -> None:
        command = (
            f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}; "
            "if [ -f /app/.agents/topchester/logs/topchester.log ]; then "
            f"  cp /app/.agents/topchester/logs/topchester.log {shlex.quote(self._REMOTE_LOG_PATH.as_posix())}; "
            "fi; "
            f"cat > {shlex.quote(self._REMOTE_METADATA_PATH.as_posix())} <<'TOPCHESTER_METADATA'\n"
            f"{json.dumps(self._run_metadata, indent=2)}\n"
            "TOPCHESTER_METADATA\n"
        )
        try:
            await self.exec_as_agent(environment, command=command, env=self._topchester_env(), cwd="/app")
        except Exception:
            pass


def _write_file_command(path: PurePosixPath, content: str) -> str:
    return f"cat > {shlex.quote(path.as_posix())} <<'TOPCHESTER_EOF'\n{content}\nTOPCHESTER_EOF\n"


def _benchmark_instruction(instruction: str) -> str:
    return f"""You are running inside an automated software engineering benchmark.

Complete the task end-to-end in the repository at /app. Do not stop after analysis, do not ask for confirmation, and do not offer to continue later. Make the necessary code and test changes directly.

This is an implementation benchmark. A final response without a successful source-file edit is incomplete unless the task truly requires no code change. Do not describe intended changes as if they were made. Use edit_file, write_file, apply_patch, or another mutating tool to make real changes before finalizing.

Use the project knowledge base that has already been prepared. Inspect the repository as needed, modify files, and run focused validation when practical. If validation is too expensive or blocked, report exactly what you ran or why it could not be run.

Use todo/plan updates sparingly in this benchmark. A short initial plan is fine for complex tasks, but do not spend tool calls maintaining checklist wording; prioritize source edits and validation.

You cannot finish this benchmark with a normal assistant message. A normal assistant message is only a progress note, and the runtime will continue the task after it.

The only valid way to end this benchmark is to call finish_task. Call finish_task only when:
- requested source changes are implemented
- relevant validation was run, or you explain why it was blocked
- files_changed lists the source files actually changed
- remaining_issues is empty or explicitly describes known incomplete work

Task:

{instruction}"""


CODE_ONLY_KB_IGNORE_PATHS = [
    "**",
    "!src/**",
    "!lib/**",
    "!app/**",
    "!apps/**",
    "!server/**",
    "!client/**",
    "!packages/*/src/**",
    "!packages/@*/*/src/**",
    "!crates/**",
    "!cmd/**",
    "!internal/**",
    "!pkg/**",
    "!scripts/**",
    "!bin/**",
    "!package.json",
    "!package-lock.json",
    "!packages/*/package.json",
    "!packages/@*/*/package.json",
    "!pnpm-workspace.yaml",
    "!tsconfig*.json",
    "!jsconfig*.json",
    "!vite.config.*",
    "!vitest.config.*",
    "!jest.config.*",
    "!eslint.config.*",
    "!prettier.config.*",
    "!rollup.config.*",
    "!webpack.config.*",
    "!rspack.config.*",
    "!next.config.*",
    "!nuxt.config.*",
    "test/**",
    "tests/**",
    "__tests__/**",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/.gitignore",
    "**/.npmignore",
    "**/.eslintignore",
    "**/LICENSE",
    "**/LICENCE",
    "**/README*",
    "**/CHANGELOG*",
    "**/docs/**",
    "**/examples/**",
    "**/demo/**",
    "**/benchmark/**",
    "**/benchmarks/**",
    "node_modules/**",
    "packages/*/node_modules/**",
    "packages/@*/*/node_modules/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "**/build/**",
    "coverage/**",
    "**/coverage/**",
    "target/**",
    ".next/**",
    ".nuxt/**",
    ".cache/**",
    "tmp/**",
    "temp/**",
    "**/__snapshots__/**",
    "**/snapshots/**",
    "**/snapshot/**",
    "**/fixtures/**",
    "**/__fixtures__/**",
    "**/testdata/**",
    "**/generated/**",
    "**/*.snap",
    "**/*.map",
    "**/*.min.*",
    "**/*.lock",
]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _sum_model_response_usage(events: list[dict[str, Any]]) -> dict[str, int | float]:
    totals: dict[str, int | float] = {
        "input_tokens": 0,
        "cache_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
    }
    for event in events:
        if event.get("event") != "model_response":
            continue
        totals["input_tokens"] += _number(event.get("inputTokens"))
        totals["cache_tokens"] += _number(event.get("cacheReadTokens")) + _number(event.get("cacheWriteTokens"))
        totals["output_tokens"] += _number(event.get("outputTokens"))
        totals["total_tokens"] += _number(event.get("totalTokens"))
        totals["cost_usd"] += _float_number(event.get("costUsd"))
    return totals


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _float_number(value: Any) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _none_if_zero(value: int | float) -> int | None:
    return int(value) if value else None


def _none_if_zero_float(value: int | float) -> float | None:
    return float(value) if value else None


def _strip_jsonc_comments(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("//"):
            continue
        lines.append(line)
    return "\n".join(lines)
