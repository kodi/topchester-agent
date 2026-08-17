import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  claimHerdrLifecycleOwnership,
  createHerdrAgentReporter,
  runHerdrLifecycleGuard,
  runHerdrLifecycleGuardIfRequested,
  TOPCHESTER_HERDR_OWNER_PID_ENV,
} from "../src/integrations/herdr.js";

const processId = 4242;
const ownedPaneEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_BIN_PATH: "/opt/herdr",
  [TOPCHESTER_HERDR_OWNER_PID_ENV]: String(processId),
};

describe("Herdr lifecycle reporting", () => {
  it("does nothing outside a Herdr pane", async () => {
    const run = vi.fn(async () => {});
    const reporter = createHerdrAgentReporter({ env: {}, processId, run });

    await reporter.report({ state: "working", sessionId: "session-1" });
    await reporter.release();

    expect(run).not.toHaveBeenCalled();
  });

  it("lets only the marked root process report", async () => {
    const run = vi.fn(async () => {});
    const ownsPane = vi.fn(async () => true);
    const reporter = createHerdrAgentReporter({
      env: { ...ownedPaneEnv, [TOPCHESTER_HERDR_OWNER_PID_ENV]: "9999" },
      processId,
      run,
      ownsPane,
    });

    await reporter.report({ state: "working" });
    await reporter.release();

    expect(ownsPane).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not claim an inherited pane when the root process is not foreground", async () => {
    const run = vi.fn(async () => {});
    const startGuard = vi.fn();
    const reporter = createHerdrAgentReporter({
      env: ownedPaneEnv,
      processId,
      run,
      ownsPane: async () => false,
      startGuard,
    });

    await reporter.report({ state: "working" });
    await reporter.release();

    expect(run).not.toHaveBeenCalled();
    expect(startGuard).not.toHaveBeenCalled();
  });

  it("reports ordered state, starts one guard, deduplicates, and releases authority", async () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const startGuard = vi.fn();
    const reporter = createHerdrAgentReporter({
      env: ownedPaneEnv,
      processId,
      ownsPane: async () => true,
      startGuard,
      async run(binary, args) {
        calls.push({ binary, args });
      },
    });

    await reporter.report({ state: "idle", sessionId: "session-1" });
    await reporter.report({ state: "idle", sessionId: "session-1" });
    await reporter.report({ state: "blocked", sessionId: "session-1", message: "Waiting for approval" });
    await reporter.release();

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      binary: "/opt/herdr",
      args: [
        "pane",
        "report-agent",
        "w1:p2",
        "--source",
        `topchester:lifecycle:${processId}`,
        "--agent",
        "topchester",
        "--state",
        "idle",
        "--seq",
        expect.any(String),
        "--agent-session-id",
        "session-1",
      ],
    });
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--state", "blocked", "--message", "Waiting for approval"]));
    expect(calls[2]?.args.slice(0, 8)).toEqual([
      "pane",
      "release-agent",
      "w1:p2",
      "--source",
      `topchester:lifecycle:${processId}`,
      "--agent",
      "topchester",
      "--seq",
    ]);
    const sequences = calls.map((call) => Number(call.args[call.args.indexOf("--seq") + 1]));
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
    expect(sequences[2]).toBeGreaterThan(sequences[1]!);
    expect(startGuard).toHaveBeenCalledTimes(1);
    expect(startGuard).toHaveBeenCalledWith({
      parentPid: processId,
      paneId: "w1:p2",
      binary: "/opt/herdr",
      source: `topchester:lifecycle:${processId}`,
    });
  });

  it("serializes an in-flight report before final release", async () => {
    const calls: string[] = [];
    let finishReport: (() => void) | undefined;
    const reportCanFinish = new Promise<void>((resolve) => {
      finishReport = resolve;
    });
    const reporter = createHerdrAgentReporter({
      env: ownedPaneEnv,
      processId,
      ownsPane: async () => true,
      startGuard() {},
      async run(_binary, args) {
        calls.push(args[1]!);
        if (args[1] === "report-agent") {
          await reportCanFinish;
        }
      },
    });

    const report = reporter.report({ state: "working" });
    const release = reporter.release();
    await vi.waitFor(() => expect(calls).toEqual(["report-agent"]));
    finishReport?.();
    await Promise.all([report, release]);

    expect(calls).toEqual(["report-agent", "release-agent"]);
  });

  it("falls back to the herdr command on PATH", async () => {
    const run = vi.fn(async () => {});
    const reporter = createHerdrAgentReporter({
      env: {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        [TOPCHESTER_HERDR_OWNER_PID_ENV]: String(processId),
      },
      processId,
      run,
      ownsPane: async () => true,
      startGuard() {},
    });

    await reporter.report({ state: "working" });

    expect(run).toHaveBeenCalledWith("herdr", expect.any(Array));
  });

  it("claims lifecycle ownership for the current root process", () => {
    const env: NodeJS.ProcessEnv = {};

    claimHerdrLifecycleOwnership(env, processId);

    expect(env[TOPCHESTER_HERDR_OWNER_PID_ENV]).toBe(String(processId));
  });

  it("runs the guard entrypoint only for a valid internal invocation", async () => {
    const run = vi.fn(async () => {});
    const isProcessAlive = vi.fn(() => false);

    expect(await runHerdrLifecycleGuardIfRequested(["bun", "bin.ts"], { run, isProcessAlive })).toBe(false);
    expect(
      await runHerdrLifecycleGuardIfRequested(
        [
          "bun",
          "bin.ts",
          "--topchester-internal-herdr-lifecycle-guard",
          "42",
          "w1:p2",
          "/opt/herdr",
          "topchester:lifecycle:42",
        ],
        { run, isProcessAlive, now: () => 100 }
      )
    ).toBe(true);

    expect(run).toHaveBeenCalledWith("/opt/herdr", [
      "pane",
      "release-agent",
      "w1:p2",
      "--source",
      "topchester:lifecycle:42",
      "--agent",
      "topchester",
      "--seq",
      "100999",
    ]);
  });

  it("releases the claim after the owner is killed with SIGKILL", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(owner, "spawn");
    const run = vi.fn(async () => {});
    const cleanup = runHerdrLifecycleGuard(
      {
        parentPid: owner.pid!,
        paneId: "w1:p2",
        binary: "/opt/herdr",
        source: `topchester:lifecycle:${owner.pid!}`,
      },
      { run }
    );

    owner.kill("SIGKILL");
    await once(owner, "exit");
    await cleanup;

    expect(run).toHaveBeenCalledWith("/opt/herdr", expect.arrayContaining(["release-agent", "w1:p2"]));
  });

  it("retries guard cleanup without touching another process source", async () => {
    const run = vi
      .fn<(binary: string, args: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("server restarting"))
      .mockRejectedValueOnce(new Error("server restarting"))
      .mockResolvedValue();
    const delay = vi.fn(async () => {});

    await runHerdrLifecycleGuard(
      { parentPid: 42, paneId: "w1:p2", binary: "/opt/herdr", source: "topchester:lifecycle:42" },
      { run, delay, isProcessAlive: () => false }
    );

    expect(run).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    for (const [, args] of run.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(["--source", "topchester:lifecycle:42"]));
    }
  });
});
