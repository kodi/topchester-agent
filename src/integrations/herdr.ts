import { basename } from "node:path";
import { spawn } from "node:child_process";

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrAgentReport {
  state: HerdrAgentState;
  sessionId?: string;
  message?: string;
}

export interface HerdrAgentReporter {
  report(report: HerdrAgentReport): Promise<void>;
  release(): Promise<void>;
}

export interface HerdrLifecycleGuardOptions {
  parentPid: number;
  paneId: string;
  binary: string;
  source: string;
}

export interface HerdrLifecycleGuardDependencies {
  isProcessAlive?: (pid: number) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
  run?: (binary: string, args: string[]) => Promise<void>;
  now?: () => number;
}

export interface CreateHerdrAgentReporterOptions {
  env?: NodeJS.ProcessEnv;
  processId?: number;
  run?: (binary: string, args: string[]) => Promise<void>;
  ownsPane?: (binary: string, paneId: string, processId: number) => Promise<boolean>;
  startGuard?: (options: HerdrLifecycleGuardOptions) => void;
}

const AGENT_LABEL = "topchester";
const REPORT_SOURCE = "topchester:lifecycle";
const COMMAND_TIMEOUT_MS = 1000;
const GUARD_POLL_INTERVAL_MS = 100;
const GUARD_RELEASE_RETRY_MS = 250;
const GUARD_RELEASE_ATTEMPTS = 20;
const GUARD_ARG = "--topchester-internal-herdr-lifecycle-guard";
export const TOPCHESTER_HERDR_OWNER_PID_ENV = "TOPCHESTER_HERDR_OWNER_PID";

export function claimHerdrLifecycleOwnership(env: NodeJS.ProcessEnv = process.env, processId = process.pid): void {
  env[TOPCHESTER_HERDR_OWNER_PID_ENV] = String(processId);
}

export async function runHerdrLifecycleGuardIfRequested(
  argv: string[] = process.argv,
  dependencies: HerdrLifecycleGuardDependencies = {}
): Promise<boolean> {
  const guardIndex = argv.indexOf(GUARD_ARG);
  if (guardIndex === -1) {
    return false;
  }

  const parentPid = Number(argv[guardIndex + 1]);
  const paneId = argv[guardIndex + 2]?.trim();
  const binary = argv[guardIndex + 3]?.trim();
  const source = argv[guardIndex + 4]?.trim();
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !paneId || !binary || !source) {
    return true;
  }

  await runHerdrLifecycleGuard({ parentPid, paneId, binary, source }, dependencies);
  return true;
}

export async function runHerdrLifecycleGuard(
  options: HerdrLifecycleGuardOptions,
  dependencies: HerdrLifecycleGuardDependencies = {}
): Promise<void> {
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const wait = dependencies.delay ?? delay;
  const run = dependencies.run ?? runHerdrCommand;
  const now = dependencies.now ?? Date.now;

  while (isProcessAlive(options.parentPid)) {
    await wait(GUARD_POLL_INTERVAL_MS);
  }

  for (let attempt = 1; attempt <= GUARD_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await run(options.binary, [
        "pane",
        "release-agent",
        options.paneId,
        "--source",
        options.source,
        "--agent",
        AGENT_LABEL,
        "--seq",
        String(now() * 1000 + 999),
      ]);
      return;
    } catch {
      if (attempt < GUARD_RELEASE_ATTEMPTS) {
        await wait(GUARD_RELEASE_RETRY_MS);
      }
    }
  }
}

export function createHerdrAgentReporter(options: CreateHerdrAgentReporterOptions = {}): HerdrAgentReporter {
  const env = options.env ?? process.env;
  const paneId = env.HERDR_PANE_ID?.trim();
  const binary = env.HERDR_BIN_PATH?.trim() || "herdr";
  const processId = options.processId ?? process.pid;
  const ownerPid = Number(env[TOPCHESTER_HERDR_OWNER_PID_ENV]);

  if (env.HERDR_ENV !== "1" || !paneId || ownerPid !== processId) {
    return disabledReporter;
  }

  const run = options.run ?? runHerdrCommand;
  const ownsPane = options.ownsPane ?? isForegroundProcessInHerdrPane;
  const startGuard = options.startGuard ?? startHerdrLifecycleGuard;
  const reportSource = `${REPORT_SOURCE}:${processId}`;
  let lastReportKey: string | undefined;
  let lastSequence = Date.now() * 1000;
  let ownership: Promise<boolean> | undefined;
  let claimed = false;
  let guardStarted = false;
  let released = false;
  let operations = Promise.resolve();

  const nextSequence = (): number => {
    lastSequence = Math.max(lastSequence + 1, Date.now() * 1000);
    return lastSequence;
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = operations.then(operation, operation);
    operations = result.catch(() => {});
    return result;
  };
  const confirmOwnership = (): Promise<boolean> => {
    ownership ??= ownsPane(binary, paneId, processId).catch(() => false);
    return ownership;
  };

  return {
    report(report) {
      return enqueue(async () => {
        if (released || !(await confirmOwnership())) {
          return;
        }
        const reportKey = JSON.stringify(report);
        if (reportKey === lastReportKey) {
          return;
        }
        lastReportKey = reportKey;
        const args = [
          "pane",
          "report-agent",
          paneId,
          "--source",
          reportSource,
          "--agent",
          AGENT_LABEL,
          "--state",
          report.state,
          "--seq",
          String(nextSequence()),
        ];
        if (report.message) {
          args.push("--message", report.message);
        }
        if (report.sessionId) {
          args.push("--agent-session-id", report.sessionId);
        }
        try {
          await run(binary, args);
          claimed = true;
          if (!guardStarted) {
            guardStarted = true;
            startGuard({ parentPid: processId, paneId, binary, source: reportSource });
          }
        } catch {
          if (lastReportKey === reportKey) {
            lastReportKey = undefined;
          }
        }
      });
    },

    release() {
      return enqueue(async () => {
        released = true;
        lastReportKey = undefined;
        if (!claimed) {
          return;
        }
        try {
          await run(binary, [
            "pane",
            "release-agent",
            paneId,
            "--source",
            reportSource,
            "--agent",
            AGENT_LABEL,
            "--seq",
            String(nextSequence()),
          ]);
        } catch {
          // The detached guard gets another chance after this process exits.
        }
      });
    },
  };
}

const disabledReporter: HerdrAgentReporter = {
  async report() {},
  async release() {},
};

function startHerdrLifecycleGuard(options: HerdrLifecycleGuardOptions): void {
  const runtimeName = basename(process.execPath).toLowerCase();
  const runsScript =
    runtimeName === "bun" || runtimeName === "bun.exe" || runtimeName === "node" || runtimeName === "node.exe";
  const script = runsScript ? process.argv[1] : undefined;
  if (runsScript && !script) {
    return;
  }
  const args = [
    ...(script ? [script] : []),
    GUARD_ARG,
    String(options.parentPid),
    options.paneId,
    options.binary,
    options.source,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function isForegroundProcessInHerdrPane(binary: string, paneId: string, processId: number): Promise<boolean> {
  const output = await runHerdrCommandWithOutput(binary, ["pane", "process-info", "--pane", paneId]);
  const response = JSON.parse(output) as {
    result?: { process_info?: { foreground_processes?: Array<{ pid?: number }> } };
  };
  return response.result?.process_info?.foreground_processes?.some((entry) => entry.pid === processId) ?? false;
}

function runHerdrCommand(binary: string, args: string[]): Promise<void> {
  return runHerdrProcess(binary, args).then(() => {});
}

function runHerdrCommandWithOutput(binary: string, args: string[]): Promise<string> {
  return runHerdrProcess(binary, args);
}

function runHerdrProcess(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Herdr command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", finish);
    child.once("close", (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`Herdr command exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}
