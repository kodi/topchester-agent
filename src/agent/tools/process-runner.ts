import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 40_000;
const DEFAULT_MAX_OUTPUT_LINES = 1_000;
export interface ProcessRunnerOptions {
  executable: string;
  args: string[];
  cwd: string;
  pathEnv?: string;
  input?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  outputLimitBytes?: number;
  outputLimitLines?: number;
  missingExecutableLabel?: string;
}

export interface ProcessRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  missingExecutable?: string;
}

export async function runProcess(options: ProcessRunnerOptions): Promise<ProcessRunnerResult> {
  const startedAt = Date.now();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const executablePath =
    options.executable.includes("/") || isAbsolute(options.executable)
      ? await resolveExecutablePath(options.executable)
      : await findExecutable(options.executable, pathEnv);

  if (!executablePath) {
    return {
      stdout: "",
      stderr: `${options.missingExecutableLabel ?? "command"} could not run because '${options.executable}' is not available on PATH.\n`,
      exitCode: 127,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      aborted: false,
      truncated: false,
      missingExecutable: options.executable,
    };
  }

  return runSpawnedProcess(executablePath, options, startedAt, pathEnv);
}

export async function findExecutable(name: string, pathEnv: string): Promise<string | undefined> {
  for (const pathEntry of pathEnv.split(delimiter).filter(Boolean)) {
    const executablePath = join(pathEntry, name);

    try {
      await access(executablePath, constants.X_OK);
      return executablePath;
    } catch {
      continue;
    }
  }

  return undefined;
}

async function resolveExecutablePath(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

export async function resolveWorkspaceCwd(workspaceRoot: string, workdir: string, toolName: string): Promise<string> {
  const resolvedCwd = resolve(workspaceRoot, workdir);
  const info = await stat(resolvedCwd);

  if (!info.isDirectory()) {
    throw new Error(`${toolName} workdir must be a directory inside the workspace: ${workdir}`);
  }

  const realWorkspace = await realpath(resolve(workspaceRoot));
  const realCwd = await realpath(resolvedCwd);
  const relativePath = relative(realWorkspace, realCwd);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${toolName} rejected path outside the workspace: ${workdir}`);
  }

  return realCwd;
}

export function formatWorkspaceRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path) || ".";
}

export function appendBoundedOutput(
  current: string,
  next: string,
  limits: { maxBytes?: number; maxLines?: number } = {}
): { output: string; truncated: boolean } {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxLines = limits.maxLines ?? DEFAULT_MAX_OUTPUT_LINES;
  const combined = current + next;
  const byteLimited = Buffer.byteLength(combined, "utf8") > maxBytes;
  const lines = combined.split("\n");
  const lineLimited = lines.length > maxLines;

  if (!byteLimited && !lineLimited) {
    return { output: combined, truncated: false };
  }

  let output = combined;

  if (byteLimited) {
    output = output.slice(0, maxBytes);
  }

  if (lineLimited) {
    output = output.split("\n").slice(0, maxLines).join("\n");
  }

  return { output: `${output.trimEnd()}\n[truncated]\n`, truncated: true };
}

export function stripUnsafeControlCharacters(output: string): string {
  return output.replace(/[^\t\n\r -~]/g, "");
}

function runSpawnedProcess(
  command: string,
  options: ProcessRunnerOptions,
  startedAt: number,
  pathEnv: string
): Promise<ProcessRunnerResult> {
  return new Promise((resolveCommand) => {
    const input = options.input ?? "";
    const detached = process.platform !== "win32";
    const child = spawn(command, options.args, {
      cwd: options.cwd,
      detached,
      env: {
        ...process.env,
        PATH: pathEnv,
        PAGER: "cat",
        GIT_PAGER: "cat",
        LESS: "-F -X",
        ...options.env,
      },
      stdio: [input.length > 0 ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const appendStdout = (next: string) => {
      const bounded = appendBoundedOutput(stdout, next, {
        maxBytes: options.outputLimitBytes,
        maxLines: options.outputLimitLines,
      });
      stdout = bounded.output;
      truncated = truncated || bounded.truncated;
    };
    const appendStderr = (next: string) => {
      const bounded = appendBoundedOutput(stderr, next, {
        maxBytes: options.outputLimitBytes,
        maxLines: options.outputLimitLines,
      });
      stderr = bounded.output;
      truncated = truncated || bounded.truncated;
    };
    const finish = (result: Omit<ProcessRunnerResult, "durationMs">) => {
      if (settled) {
        return;
      }

      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      options.abortSignal?.removeEventListener("abort", abort);
      settled = true;
      resolveCommand({ ...result, durationMs: Date.now() - startedAt });
    };
    const terminate = (reason: "timeout" | "abort") => {
      if (settled) {
        return;
      }

      if (reason === "timeout") {
        timedOut = true;
      } else {
        aborted = true;
      }

      killChild(child.pid, detached, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          killChild(child.pid, detached, "SIGKILL");
        }
      }, 250);
      forceKillTimer.unref();
    };
    const abort = () => terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);

    if (options.abortSignal?.aborted) {
      abort();
    } else {
      options.abortSignal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => appendStdout(stripUnsafeControlCharacters(chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk: Buffer) => appendStderr(stripUnsafeControlCharacters(chunk.toString("utf8"))));
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: stderr || `${error.message}\n`,
        exitCode: 1,
        timedOut,
        aborted,
        truncated,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : aborted ? 130 : (code ?? (signal ? 1 : 0)),
        timedOut,
        aborted,
        truncated,
      });
    });

    if (child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          appendStderr(`${error.message}\n`);
        }
      });
      child.stdin.end(input);
    }
  });
}

function killChild(pid: number | undefined, detached: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(detached ? -pid : pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}
