import { describe, expect, it } from "vite-plus/test";
import {
  compareBudgets,
  percentile,
  runInProcessScenario,
  summarize,
  type AcceptedBudgets,
  type PerformanceReport,
} from "../scripts/opentui/performance.js";

describe("OpenTUI performance contract", () => {
  it("calculates deterministic nearest-rank percentiles", () => {
    expect(percentile([9, 1, 5, 3], 50)).toBe(3);
    expect(summarize([9, 1, 5, 3])).toEqual({ p50: 3, p95: 9, p99: 9, max: 9 });
  });

  it("reports all privacy-safe baseline counters", async () => {
    const report = await runInProcessScenario("runtime-event-burst");
    expect(report.counters).toMatchObject({ runtimeEvents: 1000, dropped: 0, reordered: 0 });
    expect(report.native.renderTimeMs).toBe("unsupported");
  });

  it("fails count and timing budget regressions without mutating metadata", async () => {
    const report: PerformanceReport = {
      schemaVersion: 1,
      generatedAt: "1970-01-01T00:00:00.000Z",
      host: { platform: "test", arch: "test", runtime: "test" },
      mode: "in-process",
      scenarios: [
        { ...(await runInProcessScenario("reasoning-flood", 1)), durationsMs: { p50: 11, p95: 11, p99: 11, max: 11 } },
      ],
    };
    const budgets = {
      schemaVersion: 1,
      policy: { timing: "test", update: "test" },
      scenarios: { "reasoning-flood": { counters: { transientUpdates: 241 }, maxP95Ms: 10 } },
    } as unknown as AcceptedBudgets;
    expect(compareBudgets(report, budgets)).toEqual(
      expect.arrayContaining([expect.stringContaining("transientUpdates"), expect.stringContaining("p95")])
    );
  });
});
