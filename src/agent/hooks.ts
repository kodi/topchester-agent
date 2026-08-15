import { spawn } from "node:child_process";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { hookEventNames, type HookEventName, type HookHandlerConfig } from "../config/index.js";
import { type AppContext } from "../app/context.js";

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_OUTPUT_CHARS = 64_000;

const hookResponseSchema = z
  .object({
    action: z.enum(["continue", "block", "stop"]).optional(),
    decision: z.string().optional(),
    cancel: z.boolean().optional(),
    context: z.union([z.string(), z.array(z.string())]).optional(),
    message: z.string().optional(),
    feedback: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export interface HookRunPayload {
  hook_event_name: HookEventName;
  event: HookEventName;
  cwd: string;
  workspaceRoot: string;
  source: "topchester";
  session_id?: string;
  sessionId?: string;
  root_session_id?: string;
  rootSessionId?: string;
  turn_id?: string;
  turnId?: string;
  model_purpose?: string;
  model_provider?: string;
  model_id?: string;
  model_ref?: string;
  model?: {
    purpose: string;
    providerId: string;
    modelId: string;
    ref: string;
  };
  [key: string]: unknown;
}

export interface RunTopchesterHooksOptions {
  toolName?: string;
  abortSignal?: AbortSignal;
  onHookStart?: (status: HookStartStatus) => void;
}

export interface HookRunResult {
  contexts: string[];
  messages: string[];
  blocked?: HookInterruption;
  stopped?: HookInterruption;
  handlerCount: number;
}

export interface HookInterruption {
  message: string;
}

export interface HookStartStatus {
  event: HookEventName;
  statusMessage: string;
}

interface HookProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationMs: number;
  exitDurationMs?: number;
  closeWaitMs?: number;
  timeoutTriggeredMs?: number;
  abortTriggeredMs?: number;
}

type HookResponse = z.infer<typeof hookResponseSchema>;

export async function runTopchesterHooks(
  context: AppContext,
  event: HookEventName,
  payload: HookRunPayload,
  options: RunTopchesterHooksOptions = {}
): Promise<HookRunResult> {
  const handlers = getConfiguredHookHandlers(context, event, options.toolName);
  const result: HookRunResult = { contexts: [], messages: [], handlerCount: 0 };

  for (const [index, handler] of handlers.entries()) {
    result.handlerCount += 1;
    const statusMessage = handler.statusMessage?.trim();

    if (statusMessage) {
      options.onHookStart?.({ event, statusMessage });
    }

    const handlerResult = await runCommandHandler(
      context,
      event,
      payload,
      handler,
      index + 1,
      handlers.length,
      options
    );

    result.contexts.push(...handlerResult.contexts);
    result.messages.push(...handlerResult.messages);

    if (handlerResult.blocked) {
      result.blocked = handlerResult.blocked;
      break;
    }

    if (handlerResult.stopped) {
      result.stopped = handlerResult.stopped;
      break;
    }
  }

  return result;
}

export function formatHookContextsForPrompt(event: HookEventName, contexts: string[]): string {
  const normalized = contexts.map((context) => context.trim()).filter(Boolean);

  if (normalized.length === 0) {
    return "";
  }

  return [`Hook context from ${event}:`, ...normalized].join("\n\n");
}

function getConfiguredHookHandlers(
  context: AppContext,
  event: HookEventName,
  toolName: string | undefined
): HookHandlerConfig[] {
  const hooks = context.config.hooks;

  if (!hooks || hooks.enabled === false) {
    return [];
  }

  return (hooks[event] ?? []).filter((handler) => hookMatches(handler, event, toolName));
}

function hookMatches(handler: HookHandlerConfig, event: HookEventName, toolName: string | undefined): boolean {
  const matcher = handler.matcher;

  if (matcher === undefined) {
    return true;
  }

  const target = toolName ?? event;
  const matchers = Array.isArray(matcher) ? matcher : [matcher];

  return matchers.some((entry) => entry === "*" || entry === target);
}

async function runCommandHandler(
  context: AppContext,
  event: HookEventName,
  payload: HookRunPayload,
  handler: HookHandlerConfig,
  handlerOrdinal: number,
  handlerCount: number,
  options: RunTopchesterHooksOptions
): Promise<HookRunResult> {
  const timeoutMs = handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const result = await runHookProcess(handler.command ?? "", payload, {
    cwd: context.workspaceRoot,
    timeoutMs,
    abortSignal: options.abortSignal,
    env: buildHookEnv(event, options.toolName),
  });

  logHookProcessResult(context, event, handler, handlerOrdinal, handlerCount, timeoutMs, result);

  if (result.timedOut || result.aborted || result.spawnError || result.exitCode !== 0) {
    return emptyHookRunResult();
  }

  const stdout = result.stdout.trim();

  if (!stdout) {
    return emptyHookRunResult();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    logHookWarning(context, {
      event: "hook_response_parse_failed",
      hookEventName: event,
      error: error instanceof Error ? error.message : String(error),
      stdoutLength: result.stdout.length,
    });
    return emptyHookRunResult();
  }

  const response = hookResponseSchema.safeParse(parsed);

  if (!response.success) {
    logHookWarning(context, {
      event: "hook_response_invalid",
      hookEventName: event,
      issues: response.error.issues.map((issue) => issue.message),
    });
    return emptyHookRunResult();
  }

  return normalizeHookResponse(event, response.data);
}

function normalizeHookResponse(event: HookEventName, response: HookResponse): HookRunResult {
  const result = emptyHookRunResult();
  const action = normalizeHookAction(event, response);
  const message = firstNonEmpty(response.message, response.feedback, response.reason);
  const contexts = Array.isArray(response.context) ? response.context : response.context ? [response.context] : [];

  result.contexts.push(...contexts.filter((context) => context.trim().length > 0));

  if (message) {
    result.messages.push(message);
  }

  if (action === "block") {
    result.blocked = { message: message || `Hook ${event} blocked the request.` };
  } else if (action === "stop") {
    result.stopped = { message: message || `Hook ${event} stopped the turn.` };
  }

  return result;
}

function normalizeHookAction(event: HookEventName, response: HookResponse): "continue" | "block" | "stop" {
  if (response.cancel) {
    return event === "Stop" ? "stop" : "block";
  }

  if (response.action) {
    return response.action;
  }

  const decision = response.decision?.trim().toLowerCase();

  if (decision === "block" || decision === "deny" || decision === "denied") {
    return "block";
  }

  if (decision === "stop" || decision === "halt") {
    return "stop";
  }

  return "continue";
}

function buildHookEnv(event: HookEventName, toolName: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TOPCHESTER_HOOK_EVENT: event,
    TOPCHESTER_HOOK_TOOL: toolName ?? "",
  };
}

async function runHookProcess(
  command: string,
  payload: Record<string, unknown>,
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
  }
): Promise<HookProcessResult> {
  const startedAt = performance.now();
  const shell = process.env.SHELL || "/bin/sh";

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exitDurationMs: number | undefined;
    let timeoutTriggeredMs: number | undefined;
    let abortTriggeredMs: number | undefined;
    const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
    const child = spawn(shell, ["-lc", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (partial: Partial<HookProcessResult>) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abort);
      const durationMs = elapsedMs();
      const finalExitDurationMs = partial.exitDurationMs ?? exitDurationMs;
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        durationMs,
        ...(finalExitDurationMs === undefined
          ? {}
          : { exitDurationMs: finalExitDurationMs, closeWaitMs: Math.max(0, durationMs - finalExitDurationMs) }),
        ...(timeoutTriggeredMs === undefined ? {} : { timeoutTriggeredMs }),
        ...(abortTriggeredMs === undefined ? {} : { abortTriggeredMs }),
        ...partial,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutTriggeredMs = elapsedMs();
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const abort = () => {
      aborted = true;
      abortTriggeredMs = elapsedMs();
      child.kill("SIGTERM");
    };

    if (options.abortSignal?.aborted) {
      abort();
    } else {
      options.abortSignal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ spawnError: error.message });
    });
    child.on("exit", () => {
      exitDurationMs = elapsedMs();
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

function logHookProcessResult(
  context: AppContext,
  event: HookEventName,
  handler: HookHandlerConfig,
  handlerOrdinal: number,
  handlerCount: number,
  timeoutMs: number,
  result: HookProcessResult
): void {
  context.logger.debug(
    {
      event: "hook_run",
      hookEventName: event,
      handlerType: handler.type ?? "command",
      handlerOrdinal,
      handlerCount,
      handlerLabel: safeHookHandlerLabel(handler.command),
      matcher: handler.matcher,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      spawnError: result.spawnError,
      durationMs: result.durationMs,
      exitDurationMs: result.exitDurationMs,
      closeWaitMs: result.closeWaitMs,
      timeoutTriggeredMs: result.timeoutTriggeredMs,
      abortTriggeredMs: result.abortTriggeredMs,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    },
    "hook run"
  );
}

function safeHookHandlerLabel(command: string): string {
  const tokens = command.trim().split(/\s+/u).filter(Boolean);
  let index = 0;

  if (safeCommandToken(tokens[index]) === "env") {
    index += 1;
  }
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) {
    index += 1;
  }

  const executable = safeCommandToken(tokens[index]);
  const executableLabel = safeBasename(executable) ?? "command";
  const interpreters = new Set(["bash", "bun", "dash", "node", "nodejs", "python", "python3", "sh", "zsh"]);

  if (!interpreters.has(executableLabel)) {
    return executableLabel;
  }

  const remaining = tokens.slice(index + 1);
  if (remaining.some((token) => token === "-c" || token === "--eval" || token === "-e")) {
    return executableLabel;
  }

  const script = remaining.find((token) => !token.startsWith("-"));
  const scriptLabel = safeBasename(safeCommandToken(script));

  return scriptLabel && /\.(?:bash|c?js|command|mjs|py|sh|ts|zsh)$/u.test(scriptLabel) ? scriptLabel : executableLabel;
}

function safeCommandToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^["']|["']$/gu, "");
}

function safeBasename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const label = basename(value);
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(label) ? label : undefined;
}

function logHookWarning(context: AppContext, payload: Record<string, unknown>): void {
  const logger = context.logger as { warn?: (payload: Record<string, unknown>, message: string) => void };

  if (typeof logger.warn === "function") {
    logger.warn(payload, "hook warning");
    return;
  }

  context.logger.debug(payload, "hook warning");
}

function emptyHookRunResult(): HookRunResult {
  return { contexts: [], messages: [], handlerCount: 0 };
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURED_OUTPUT_CHARS) {
    return current;
  }

  return `${current}${chunk}`.slice(0, MAX_CAPTURED_OUTPUT_CHARS);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

export function isHookEventName(value: string): value is HookEventName {
  return hookEventNames.includes(value as HookEventName);
}
