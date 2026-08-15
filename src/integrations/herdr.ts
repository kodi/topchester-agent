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

export interface CreateHerdrAgentReporterOptions {
  env?: NodeJS.ProcessEnv;
  run?: (binary: string, args: string[]) => Promise<void>;
}

const AGENT_LABEL = "topchester";
const REPORT_SOURCE = "topchester:lifecycle";
const COMMAND_TIMEOUT_MS = 1000;

export function createHerdrAgentReporter(options: CreateHerdrAgentReporterOptions = {}): HerdrAgentReporter {
  const env = options.env ?? process.env;
  const paneId = env.HERDR_PANE_ID?.trim();
  const binary = env.HERDR_BIN_PATH?.trim() || "herdr";
  const run = options.run ?? runHerdrCommand;

  if (env.HERDR_ENV !== "1" || !paneId) {
    return disabledReporter;
  }

  let lastReportKey: string | undefined;
  let lastSequence = Date.now() * 1000;

  const nextSequence = (): number => {
    lastSequence = Math.max(lastSequence + 1, Date.now() * 1000);
    return lastSequence;
  };

  return {
    async report(report) {
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
        REPORT_SOURCE,
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
      } catch {
        if (lastReportKey === reportKey) {
          lastReportKey = undefined;
        }
      }
    },

    async release() {
      lastReportKey = undefined;
      try {
        await run(binary, [
          "pane",
          "release-agent",
          paneId,
          "--source",
          REPORT_SOURCE,
          "--agent",
          AGENT_LABEL,
          "--seq",
          String(nextSequence()),
        ]);
      } catch {
        // Herdr reporting is best effort and must never prevent Topchester from exiting.
      }
    },
  };
}

const disabledReporter: HerdrAgentReporter = {
  async report() {},
  async release() {},
};

function runHerdrCommand(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "ignore", windowsHide: true });
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
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Herdr command timed out after ${COMMAND_TIMEOUT_MS}ms.`));
    }, COMMAND_TIMEOUT_MS);
    timeout.unref?.();
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
