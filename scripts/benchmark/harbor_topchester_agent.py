from __future__ import annotations

import json
import shlex
import time
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class TopchesterAgent(BaseInstalledAgent):
    """Harbor custom agent for Terminal-Bench runs with Topchester."""

    SUPPORTS_ATIF: bool = True

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
        logs_dir: Path,
        *args: Any,
        npm_package: str = "topchester-ai",
        node_version: str = "24",
        topchester_binary: str = "topchester",
        config_jsonc: str | None = None,
        config_jsonc_file: str | None = None,
        kb_model: str | None = None,
        tool_protocol: str | None = None,
        openrouter_tool_routing: str | None = None,
        kb_ignore_mode: str = "terminal-bench",
        kb_max_files: int = 500,
        benchmark_prompt: bool = True,
        plan_todo_mode: str = "compact",
        max_plan_todo_updates: int | None = 3,
        max_tool_calls_per_turn: int | str | None = 5000000,
        prewarm_kb: bool = True,
        prewarm_full: bool = True,
        dangerously_auto_approve_flag: str = "--dangerously-auto-approve",
        benchmark_profile: str = "terminal-bench",
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
        self._max_tool_calls_per_turn = max_tool_calls_per_turn
        self._prewarm_kb = prewarm_kb
        self._prewarm_full = prewarm_full
        self._dangerously_auto_approve_flag = dangerously_auto_approve_flag
        self._benchmark_profile = benchmark_profile
        self._run_metadata: dict[str, Any] = {}
        super().__init__(logs_dir, *args, **kwargs)

    @staticmethod
    def name() -> str:
        return "topchester"

    def get_version_command(self) -> str | None:
        return (
            "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
            f"{shlex.quote(self._topchester_binary)} --version"
        )

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                "  apk add --no-cache bash curl git npm nodejs ripgrep; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y bash curl git ripgrep; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y bash curl git ripgrep; "
                "else "
                "  echo 'Warning: no known package manager found' >&2; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        version_spec = f"@{self._version}" if self._version else "@latest"
        package_spec = f"{self._npm_package}{version_spec}"
        await self.exec_as_agent(
            environment,
            command=(
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
            ),
        )

        await self.exec_as_root(
            environment,
            command=(
                "if [ -s /root/.nvm/nvm.sh ]; then . /root/.nvm/nvm.sh; fi; "
                "if [ -s /home/agent/.nvm/nvm.sh ]; then . /home/agent/.nvm/nvm.sh; fi; "
                "for bin in node npm npx topchester; do "
                "  BIN_PATH=\"$(command -v \"$bin\" 2>/dev/null || true)\"; "
                "  if [ -n \"$BIN_PATH\" ] && [ \"$BIN_PATH\" != \"/usr/local/bin/$bin\" ]; then "
                "    ln -sf \"$BIN_PATH\" \"/usr/local/bin/$bin\"; "
                "  fi; "
                "done"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        topchester_instruction = _terminal_bench_instruction(instruction) if self._benchmark_prompt else instruction

        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}")
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
                command=self._run_command(),
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
                    "ignore_mode": self._kb_ignore_mode,
                },
                "prompt": {"benchmark_wrapper": self._benchmark_prompt, "kind": "terminal-bench"},
                "plan_todo": {
                    "mode": self._plan_todo_mode,
                    "max_updates_per_turn": self._max_plan_todo_updates,
                },
                "tool_calls": {
                    "max_per_turn": self._max_tool_calls_per_turn,
                },
                "models": {
                    "agent": self.model_name,
                    "kb_summarize": self._kb_model or self.model_name,
                },
                "agent_run": {"duration_ms": run_duration_ms},
                "benchmark_profile": self._benchmark_profile,
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
        context.metadata = {
            "topchester": {
                **self._run_metadata,
                "usage_source": "topchester.log model_response events",
                "log_event_count": len(log_events),
                "run_event_count": len(run_events),
                "n_agent_steps": n_agent_steps or None,
                "model_response_usage": usage,
            }
        }

        _write_json(self.logs_dir / "topchester-metadata.json", context.metadata)
        trajectory = _build_trajectory(
            run_events=run_events,
            metadata=context.metadata,
            agent_version=self._version or "unknown",
            model_name=self.model_name,
        )
        if trajectory is not None:
            _write_json(self.logs_dir / "trajectory.json", trajectory)

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
        ignore_paths = _resolve_ignore_paths(self._kb_ignore_mode)
        return json.dumps(
            {
                "$schema": "https://topchester.com/schemas/config.v1.json",
                "models": {
                    "default": model,
                    "kb.summarize": kb_model,
                },
                **provider_config,
                **({"ignore": {"paths": ignore_paths}} if ignore_paths else {}),
            },
            indent=2,
        )

    def _topchester_env(self) -> dict[str, str]:
        env = self._build_process_env(
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
        if self._max_tool_calls_per_turn is not None:
            env["TOPCHESTER_MAX_TOOL_CALLS_PER_TURN"] = str(self._max_tool_calls_per_turn)
        if self._get_env("OPENROUTER_API_KEY"):
            env["OPENROUTER_API_KEY"] = self._get_env("OPENROUTER_API_KEY") or ""
        if self._get_env("OPENAI_API_KEY"):
            env["OPENAI_API_KEY"] = self._get_env("OPENAI_API_KEY") or ""
        return env

    def _build_process_env(self, values: dict[str, str]) -> dict[str, str]:
        env = {**self.resolve_env_vars(), **values}
        for key, value in self._extra_env.items():
            env.setdefault(key, value)
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
find /app -type f \
  -not -path '/app/.git/*' \
  -not -path '/app/node_modules/*' \
  -not -path '/app/topchester-kb/*' \
  -not -path '/app/.agents/*' \
  | sed 's#^/app/##' | sort > {output_path}
count="$(wc -l < {output_path} | tr -d ' ')"
echo "KB inventory files: $count"
if [ {max_files} -gt 0 ] && [ "$count" -gt {max_files} ]; then
  echo "KB inventory exceeds kb_max_files={max_files}; refusing prewarm. Set --ak kb_max_files=0 to disable." >&2
  sed -n '1,120p' {output_path} >&2
  exit 42
fi
"""
        return f"bash -lc {shlex.quote(inner)}"

    def _run_command(self) -> str:
        events_path = self._REMOTE_EVENTS_PATH.as_posix()
        stdout_path = self._REMOTE_RUN_STDOUT_PATH.as_posix()
        inner = (
            "set -o pipefail; "
            f"{self._base_topchester_command()} run "
            f"{shlex.quote(self._dangerously_auto_approve_flag)} "
            f"--benchmark-profile {shlex.quote(self._benchmark_profile)} "
            f"--json --output-json {shlex.quote(events_path)} "
            f"\"$(cat {shlex.quote(self._REMOTE_INSTRUCTION_PATH.as_posix())})\" "
            f"2>&1 | tee {shlex.quote(stdout_path)}; "
            'status="${PIPESTATUS[0]}"; '
            f"if [ -s {shlex.quote(events_path)} ]; then exit 0; fi; "
            'exit "$status"'
        )
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


def _terminal_bench_instruction(instruction: str) -> str:
    return f"""You are running inside Terminal-Bench through Harbor.

Complete the task end-to-end in the repository or terminal environment at /app. Do not stop after analysis, do not ask for confirmation, and do not offer to continue later. Make the required file, code, data, service, system, or shell changes directly.

Use the project knowledge base that has already been prepared. Inspect the repository and environment as needed. Terminal-Bench tasks may require shell commands, generated files, certificates, archives, local services, package setup, or validation scripts; use the right terminal tools for the task.

Inspect `/tests` when it exists and satisfy the verifier's exact file paths, names, and formats. If the task involves image or frame output and the expected path is unclear, create `/tmp/frame.bmp` in addition to any natural project output path.

If validation is practical, run focused checks. If validation is too expensive or blocked, report exactly what you ran or why it could not be run.

Favor an early working artifact over extended up-front analysis: once you have enough context for a plausible first attempt, create or modify the required files and iterate from runtime or verifier feedback. The artifact must be an honest implementation attempt for the requested behavior, not a placeholder, stub, hard-coded verifier artifact, or synthetic substitute. Use task only for narrow read-only questions about a specific file, symbol, or behavior; do not use it to explore whole repositories, directories, test suites, binaries, or large source trees.

Use todo/plan updates sparingly in this benchmark. A short initial plan is fine for complex tasks, but prioritize completing the environment and preserving evidence.

You cannot finish this benchmark with a normal assistant message. A normal assistant message is only a progress note, and the runtime will continue the task after it.

The only valid way to end this benchmark is to call finish_task. Call finish_task only when:
- requested changes are implemented
- relevant validation was run, or you explain why it was blocked
- files_changed lists files actually created or changed when applicable
- remaining_issues is empty
- the solution is not a placeholder, stub, hard-coded verifier artifact, or synthetic substitute for the requested behavior

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
    "node_modules/**",
    "**/node_modules/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "**/build/**",
    "coverage/**",
    "**/coverage/**",
    "target/**",
]

TERMINAL_BENCH_KB_IGNORE_PATHS = [
    ".git/**",
    ".agents/**",
    "topchester-kb/**",
    "node_modules/**",
    "**/node_modules/**",
    ".venv/**",
    "venv/**",
    "__pycache__/**",
    "**/__pycache__/**",
    ".cache/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "**/build/**",
    "target/**",
    "coverage/**",
    "**/*.png",
    "**/*.jpg",
    "**/*.jpeg",
    "**/*.gif",
    "**/*.pdf",
    "**/*.zip",
    "**/*.7z",
    "**/*.tar",
    "**/*.gz",
    "**/*.bin",
    "**/*.pt",
    "**/*.pth",
]


def _resolve_ignore_paths(mode: str) -> list[str]:
    if mode == "none":
        return []
    if mode == "code":
        return CODE_ONLY_KB_IGNORE_PATHS
    if mode == "terminal-bench":
        return TERMINAL_BENCH_KB_IGNORE_PATHS
    raise ValueError("kb_ignore_mode must be one of: terminal-bench, code, none")


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


def _build_trajectory(
    run_events: list[dict[str, Any]],
    metadata: dict[str, Any],
    agent_version: str,
    model_name: str | None,
) -> dict[str, Any] | None:
    steps: list[dict[str, Any]] = []
    session_id: str | None = None

    for event in run_events:
        session_id = session_id or event.get("sessionId")
        timestamp = event.get("ts")
        event_type = event.get("type")
        payload = event.get("event")

        if event_type == "user.message":
            steps.append(
                {
                    "step_id": len(steps) + 1,
                    "timestamp": timestamp,
                    "source": "user",
                    "message": str(event.get("text", "")),
                }
            )
            continue

        if not isinstance(payload, dict):
            continue

        if payload.get("type") == "message":
            role = payload.get("role")
            steps.append(
                {
                    "step_id": len(steps) + 1,
                    "timestamp": timestamp,
                    "source": "agent" if role == "assistant" else "system",
                    "message": str(payload.get("text", "")),
                    **({"model_name": model_name} if role == "assistant" and model_name else {}),
                }
            )
            continue

        if payload.get("type") == "tool_call":
            tool_name = str(payload.get("tool") or payload.get("label") or "tool")
            call_id = str(payload.get("id") or f"tool-{len(steps) + 1}")
            content = payload.get("content") or payload.get("label") or ""
            steps.append(
                {
                    "step_id": len(steps) + 1,
                    "timestamp": timestamp,
                    "source": "agent",
                    "message": str(payload.get("label") or f"Executed {tool_name}"),
                    "model_name": model_name,
                    "tool_calls": [
                        {
                            "tool_call_id": call_id,
                            "function_name": tool_name,
                            "arguments": payload.get("args") if isinstance(payload.get("args"), dict) else {},
                        }
                    ],
                    "observation": {
                        "results": [
                            {
                                "source_call_id": call_id,
                                "content": str(content),
                            }
                        ]
                    },
                }
            )

    if not steps:
        return None

    usage = metadata.get("topchester", {}).get("model_response_usage", {})
    return {
        "schema_version": "ATIF-v1.7",
        "session_id": session_id,
        "agent": {
            "name": "topchester",
            "version": agent_version,
            "model_name": model_name,
            "extra": metadata.get("topchester"),
        },
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": _none_if_zero(_number(usage.get("input_tokens"))),
            "total_completion_tokens": _none_if_zero(_number(usage.get("output_tokens"))),
            "total_cached_tokens": _none_if_zero(_number(usage.get("cache_tokens"))),
            "total_cost_usd": _none_if_zero_float(_float_number(usage.get("cost_usd"))),
            "total_steps": len(steps),
        },
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    try:
        path.write_text(json.dumps(payload, indent=2) + "\n")
    except OSError:
        pass


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _float_number(value: Any) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _none_if_zero(value: int | float) -> int | None:
    return int(value) if value else None


def _none_if_zero_float(value: int | float) -> float | None:
    return float(value) if value else None


def _strip_jsonc_comments(text: str) -> str:
    result: list[str] = []
    in_string = False
    escaped = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(text):
        char = text[i]
        next_char = text[i + 1] if i + 1 < len(text) else ""

        if in_line_comment:
            if char in "\r\n":
                in_line_comment = False
                result.append(char)
            i += 1
            continue

        if in_block_comment:
            if char == "*" and next_char == "/":
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue

        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue

        if char == '"':
            in_string = True
            result.append(char)
            i += 1
            continue

        if char == "/" and next_char == "/":
            in_line_comment = True
            i += 2
            continue

        if char == "/" and next_char == "*":
            in_block_comment = True
            i += 2
            continue

        result.append(char)
        i += 1

    return "".join(result)
