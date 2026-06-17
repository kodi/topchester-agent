import { access, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { composeFilePath, miniBenchRoot, repoRoot } from "./paths.ts";
import { runCommand, type CommandResult } from "./command.ts";
import type { LoadedTask } from "./task-loader.ts";

export interface AgentRunResult {
  result: CommandResult;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  eventsSourcePath?: string;
  topchesterArtifactsPath?: string;
  sessionEventPaths: string[];
  debugLogPath?: string;
  stdoutTail: string;
  stderrTail: string;
  toolCalls: Record<string, number>;
  eventCount: number;
  eventKinds: Record<string, number>;
  messageRoles: Record<string, number>;
  taskPlanCount: number;
  todoUpdateCount: number;
  statusCount: number;
}

export async function runTopchesterForTask(input: {
  task: LoadedTask;
  workspacePath: string;
  runPath: string;
  model?: string;
  config?: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}): Promise<AgentRunResult> {
  const promptPath = resolve(input.task.taskPath, input.task.definition.prompt);
  const eventsPath = resolve(input.runPath, "topchester-events.jsonl");
  const stdoutPath = resolve(input.runPath, "topchester.stdout");
  const stderrPath = resolve(input.runPath, "topchester.stderr");
  const prompt = await readFile(promptPath, "utf8");

  await mkdir(input.runPath, { recursive: true });
  const result =
    getTopchesterRuntime() === "host"
      ? await runHostTopchester({
          workspacePath: input.workspacePath,
          config: input.config,
          model: input.model,
          timeoutMs: input.timeoutMs,
          eventsPath,
          prompt,
          onProgress: input.onProgress,
        })
      : await runContainerTopchester({
          workspacePath: input.workspacePath,
          runPath: input.runPath,
          config: input.config,
          model: input.model,
          timeoutMs: input.timeoutMs,
          prompt,
          onProgress: input.onProgress,
        });

  await writeFile(stdoutPath, result.stdout);
  await writeFile(stderrPath, result.stderr);
  const artifacts = await preserveTopchesterArtifacts(input.workspacePath, input.runPath);
  const eventSummary = await summarizeEvents(eventsPath, input.workspacePath, artifacts.sessionEventPaths);

  return {
    result,
    stdoutPath,
    stderrPath,
    eventsPath,
    eventsSourcePath: eventSummary.eventsSourcePath,
    topchesterArtifactsPath: artifacts.artifactsPath,
    sessionEventPaths: artifacts.sessionEventPaths,
    debugLogPath: artifacts.debugLogPath,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    ...eventSummary,
  };
}

type TopchesterRuntime = "container" | "host";

function getTopchesterRuntime(): TopchesterRuntime {
  const runtime = process.env.MINI_BENCH_TOPCHESTER_RUNTIME;
  if (!runtime || runtime === "container") {
    return "container";
  }
  if (runtime === "host") {
    return "host";
  }
  throw new Error(`Unsupported MINI_BENCH_TOPCHESTER_RUNTIME '${runtime}'. Expected 'container' or 'host'.`);
}

async function runHostTopchester(input: {
  workspacePath: string;
  config?: string;
  model?: string;
  timeoutMs: number;
  eventsPath: string;
  prompt: string;
  onProgress?: (message: string) => void;
}): Promise<CommandResult> {
  const executable = await resolveTopchesterExecutable();
  const args = [
    "--workspace",
    input.workspacePath,
    ...(input.config ? ["--config", input.config] : []),
    "run",
    "--dangerously-auto-approve",
    "--timeout",
    String(input.timeoutMs),
    "--json",
    "--output-json",
    input.eventsPath,
  ];

  if (input.model) {
    args.push("--model", input.model);
  }

  args.push(input.prompt);

  return runCommand(executable.command, [...executable.args, ...args], {
    cwd: repoRoot,
    timeoutMs: input.timeoutMs + 10_000,
    progressIntervalMs: 10_000,
    onProgress: (elapsedMs) => input.onProgress?.(`agent still running (${formatDuration(elapsedMs)})`),
  });
}

async function runContainerTopchester(input: {
  workspacePath: string;
  runPath: string;
  config?: string;
  model?: string;
  timeoutMs: number;
  prompt: string;
  onProgress?: (message: string) => void;
}): Promise<CommandResult> {
  const configPath = await resolveContainerConfigPath(input.runPath, input.config);
  const packageSpec = process.env.MINI_BENCH_TOPCHESTER_NPM_SPEC ?? "topchester-ai@latest";
  const composeEnv = {
    ...process.env,
    MINI_BENCH_WORKSPACE: input.workspacePath,
    MINI_BENCH_TOPCHESTER_NPM_SPEC: packageSpec,
  };

  input.onProgress?.(`building agent image (${packageSpec})`);
  const build = await runCommand("docker", ["compose", "-f", composeFilePath, "build", "agent"], {
    cwd: miniBenchRoot,
    env: composeEnv,
    timeoutMs: 300_000,
    progressIntervalMs: 15_000,
    onProgress: (elapsedMs) => input.onProgress?.(`agent image build still running (${formatDuration(elapsedMs)})`),
  });

  if (build.exitCode !== 0) {
    return {
      ...build,
      stdout: build.stdout,
      stderr: [`docker compose build agent failed for ${packageSpec}`, build.stderr].filter(Boolean).join("\n"),
    };
  }

  const containerEventsPath = "/run/topchester-events.jsonl";
  const args = [
    "compose",
    "-f",
    composeFilePath,
    "run",
    "--rm",
    "--volume",
    `${input.runPath}:/run`,
    "--volume",
    `${configPath}:/bench/topchester-config.jsonc:ro`,
    "--env",
    "HOME=/tmp/topchester-home",
    "--env",
    "PNPM_HOME=/tmp/pnpm-home",
    "--env",
    "npm_config_store_dir=/tmp/pnpm-store",
    "--env",
    "TOPCHESTER_MINI_BENCH=1",
    ...forwardedEnvArgs(["OPENROUTER_API_KEY"]),
    "agent",
    "topchester",
    "--workspace",
    "/workspace",
    "--config",
    "/bench/topchester-config.jsonc",
    "run",
    "--dangerously-auto-approve",
    "--timeout",
    String(input.timeoutMs),
    "--json",
    "--output-json",
    containerEventsPath,
  ];

  if (input.model) {
    args.push("--model", input.model);
  }

  args.push(input.prompt);

  input.onProgress?.("starting Topchester in agent container");
  return runCommand("docker", args, {
    cwd: miniBenchRoot,
    env: composeEnv,
    timeoutMs: input.timeoutMs + 30_000,
    progressIntervalMs: 10_000,
    onProgress: (elapsedMs) => input.onProgress?.(`agent still running (${formatDuration(elapsedMs)})`),
  });
}

async function resolveContainerConfigPath(runPath: string, config?: string): Promise<string> {
  if (config) {
    return resolve(repoRoot, config);
  }

  const emptyConfigPath = resolve(runPath, "empty-topchester-config.jsonc");
  await writeFile(emptyConfigPath, "{}\n");
  return emptyConfigPath;
}

function forwardedEnvArgs(names: string[]): string[] {
  const args: string[] = [];
  for (const name of names) {
    if (process.env[name] !== undefined) {
      args.push("--env", name);
    }
  }
  return args;
}

export async function summarizeEvents(
  eventsPath: string,
  workspacePath?: string,
  preservedSessionEventPaths: string[] = []
): Promise<{
  toolCalls: Record<string, number>;
  eventCount: number;
  eventKinds: Record<string, number>;
  messageRoles: Record<string, number>;
  taskPlanCount: number;
  todoUpdateCount: number;
  statusCount: number;
  eventsSourcePath?: string;
}> {
  const toolCalls: Record<string, number> = {};
  const eventKinds: Record<string, number> = {};
  const messageRoles: Record<string, number> = {};
  const eventSource = await readEventSource(eventsPath, workspacePath, preservedSessionEventPaths);
  const source = eventSource?.content ?? "";
  let eventCount = 0;
  let taskPlanCount = 0;
  let todoUpdateCount = 0;
  let statusCount = 0;

  for (const line of source.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    eventCount += 1;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const kind = extractEventKind(event);
    if (kind) {
      eventKinds[kind] = (eventKinds[kind] ?? 0) + 1;
      if (kind === "task_plan") {
        taskPlanCount += 1;
      }
      if (kind === "status") {
        statusCount += 1;
      }
    }

    const role = extractMessageRole(event, kind);
    if (role) {
      messageRoles[role] = (messageRoles[role] ?? 0) + 1;
    }

    const tool = extractToolName(event);
    if (tool) {
      toolCalls[tool] = (toolCalls[tool] ?? 0) + 1;
      if (tool === "plan_todo") {
        todoUpdateCount += 1;
      }
    }
  }

  return {
    toolCalls,
    eventCount,
    eventKinds,
    messageRoles,
    taskPlanCount,
    todoUpdateCount,
    statusCount,
    eventsSourcePath: eventSource?.path,
  };
}

function extractEventKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const event = value as {
    event?: { type?: string };
    kind?: string;
    type?: string;
  };

  return event.type ?? event.kind ?? event.event?.type;
}

function extractMessageRole(value: unknown, kind?: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const event = value as {
    event?: { role?: string; type?: string };
    role?: string;
    type?: string;
  };

  if (kind === "user.message") {
    return "user";
  }

  if (typeof event.role === "string") {
    return event.role;
  }

  if (kind === "message" && typeof event.event?.role === "string") {
    return event.event.role;
  }

  return undefined;
}

function extractToolName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const event = value as {
    call?: { tool?: string };
    event?: { type?: string; call?: { tool?: string } };
    tool?: string;
    type?: string;
  };

  if (typeof event.call?.tool === "string") {
    return event.call.tool;
  }

  if (typeof event.event?.call?.tool === "string") {
    return event.event.call.tool;
  }

  if (typeof event.tool === "string") {
    return event.tool;
  }

  return undefined;
}

async function preserveTopchesterArtifacts(
  workspacePath: string,
  runPath: string
): Promise<{ artifactsPath?: string; sessionEventPaths: string[]; debugLogPath?: string }> {
  const sourcePath = resolve(workspacePath, ".agents", "topchester");
  const artifactsPath = resolve(runPath, "topchester-artifacts");

  try {
    await access(sourcePath);
  } catch {
    return { sessionEventPaths: [] };
  }

  await cp(sourcePath, artifactsPath, { recursive: true, force: true });
  const sessionEventPaths = await findFilesByName(resolve(artifactsPath, "sessions"), "events.jsonl");
  const debugLogPath = resolve(artifactsPath, "logs", "topchester.log");

  try {
    await access(debugLogPath);
  } catch {
    return { artifactsPath, sessionEventPaths };
  }

  return { artifactsPath, sessionEventPaths, debugLogPath };
}

async function findFilesByName(root: string, filename: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await findFilesByName(entryPath, filename)));
    } else if (entry.isFile() && entry.name === filename) {
      paths.push(entryPath);
    }
  }

  return paths.sort();
}

async function readEventSource(
  eventsPath: string,
  workspacePath?: string,
  preservedSessionEventPaths: string[] = []
): Promise<{ path: string; content: string } | undefined> {
  const requested = await readFile(eventsPath, "utf8").catch(() => undefined);
  if (requested !== undefined && requested.trim()) {
    return { path: eventsPath, content: requested };
  }

  const preservedSessionEvents = preservedSessionEventPaths.at(-1);
  if (preservedSessionEvents) {
    const content = await readFile(preservedSessionEvents, "utf8").catch(() => undefined);
    if (content !== undefined) {
      return { path: preservedSessionEvents, content };
    }
  }

  if (!workspacePath) {
    return requested !== undefined ? { path: eventsPath, content: requested } : undefined;
  }

  const sessionEvents = await findLatestSessionEvents(workspacePath);
  if (!sessionEvents) {
    return requested !== undefined ? { path: eventsPath, content: requested } : undefined;
  }

  const content = await readFile(sessionEvents, "utf8").catch(() => undefined);
  return content === undefined ? undefined : { path: sessionEvents, content };
}

async function findLatestSessionEvents(workspacePath: string): Promise<string | undefined> {
  const sessionsPath = resolve(workspacePath, ".agents", "topchester", "sessions");
  const entries = await readdir(sessionsPath, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const eventsPath = resolve(sessionsPath, entry.name, "events.jsonl");
    const eventsStat = await stat(eventsPath).catch(() => undefined);
    if (eventsStat) {
      candidates.push({ path: eventsPath, mtimeMs: eventsStat.mtimeMs });
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path;
}

function tail(value: string, maxChars = 4_000): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function resolveTopchesterExecutable(): Promise<{ command: string; args: string[] }> {
  if (process.env.MINI_BENCH_TOPCHESTER_COMMAND) {
    const [command, ...args] = process.env.MINI_BENCH_TOPCHESTER_COMMAND.split(" ").filter(Boolean);
    if (!command) {
      throw new Error("MINI_BENCH_TOPCHESTER_COMMAND did not contain a command");
    }
    return { command, args };
  }

  const sourceRunner = resolve(repoRoot, "node_modules/.bin/tsx");
  const builtCli = resolve(repoRoot, "dist", "bin.mjs");

  try {
    await access(builtCli);
    return { command: process.execPath, args: [builtCli] };
  } catch {
    await access(sourceRunner);
    return {
      command: sourceRunner,
      args: ["src/bin.ts"],
    };
  }
}
