import { describe, expect, it, vi } from "vite-plus/test";
import { createHerdrAgentReporter } from "../src/integrations/herdr.js";

describe("Herdr lifecycle reporting", () => {
  it("does nothing outside a Herdr pane", async () => {
    const run = vi.fn(async () => {});
    const reporter = createHerdrAgentReporter({ env: {}, run });

    await reporter.report({ state: "working", sessionId: "session-1" });
    await reporter.release();

    expect(run).not.toHaveBeenCalled();
  });

  it("reports ordered state and session identity, deduplicates, and releases authority", async () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const reporter = createHerdrAgentReporter({
      env: {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        HERDR_BIN_PATH: "/opt/herdr",
      },
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
        "topchester:lifecycle",
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
      "topchester:lifecycle",
      "--agent",
      "topchester",
      "--seq",
    ]);
    const sequences = calls.map((call) => Number(call.args[call.args.indexOf("--seq") + 1]));
    expect(sequences[1]).toBeGreaterThan(sequences[0]!);
    expect(sequences[2]).toBeGreaterThan(sequences[1]!);
  });

  it("falls back to the herdr command on PATH", async () => {
    const run = vi.fn(async () => {});
    const reporter = createHerdrAgentReporter({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
      run,
    });

    await reporter.report({ state: "working" });

    expect(run).toHaveBeenCalledWith("herdr", expect.any(Array));
  });
});
