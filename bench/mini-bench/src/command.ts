import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
    progressIntervalMs?: number;
    onProgress?: (elapsedMs: number) => void;
  } = {}
): Promise<CommandResult> {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let closed = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  if (options.input !== undefined) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!closed) {
              child.kill("SIGKILL");
            }
          }, 2_000).unref();
        }, options.timeoutMs);
  const progress =
    options.onProgress && options.progressIntervalMs
      ? setInterval(() => options.onProgress?.(Date.now() - startedAt), options.progressIntervalMs)
      : undefined;

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      resolve(code);
    });
  });

  if (timeout) {
    clearTimeout(timeout);
  }
  if (progress) {
    clearInterval(progress);
  }

  return {
    command,
    args,
    cwd: options.cwd,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}
