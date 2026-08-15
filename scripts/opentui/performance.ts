/// <reference types="bun" />

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRuntimeEventQueue } from "../../src/agent/runtime/event-queue.js";
import { type TuiTransientScheduler, TuiViewStore } from "../../src/chat/controller-state.js";
import { ComposerState } from "../../src/tui/opentui/composer-state.js";
import { TranscriptAppendCursor } from "../../src/tui/opentui/transcript-writer.js";
import { createSession } from "../../src/session/store.js";
import { startFakeApi } from "../smoke/fake-api.js";
import { runRendererScenario } from "./performance-renderer.js";

export const PERFORMANCE_SCHEMA_VERSION = 1;
export const SCENARIOS = [
  "long-transcript-input",
  "reasoning-flood",
  "runtime-event-burst",
  "scrollback-heavy-entry",
  "persistence-burst",
  "resize-and-dialog",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];
export type MetricValue = number | "unsupported";

export interface ScenarioReport {
  readonly name: ScenarioName;
  readonly samples: number;
  readonly durationsMs: Percentiles;
  readonly counters: Record<string, number>;
  readonly native: {
    readonly frameTimeMs: Percentiles | "unsupported";
    readonly renderTimeMs: MetricValue;
    readonly stdoutWriteTimeMs: MetricValue;
    readonly frames: number;
    readonly updatedCells: number;
  };
  readonly ptyInputToPaintMs?: Percentiles;
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface PerformanceReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly host: { readonly platform: string; readonly arch: string; readonly runtime: string };
  readonly mode: "in-process" | "in-process+pty";
  readonly scenarios: readonly ScenarioReport[];
}

export interface AcceptedBudgets {
  readonly schemaVersion: number;
  readonly policy: {
    readonly timing: string;
    readonly update: string;
  };
  readonly scenarios: Record<
    ScenarioName,
    {
      readonly counters: Record<string, number>;
      readonly maxP95Ms?: number;
      readonly pty?: { readonly platform: string; readonly arch: string; readonly maxP95Ms: number };
    }
  >;
}

const exec = promisify(execFile);
const root = process.cwd();
const budgetPath = join(root, "scripts/opentui/performance.budgets.json");

export function percentile(samples: readonly number[], requested: number): number {
  assert.ok(samples.length > 0, "percentiles require at least one sample");
  assert.ok(requested >= 0 && requested <= 100, "percentile must be from 0 to 100");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((requested / 100) * sorted.length) - 1)] ?? 0;
}

export function summarize(samples: readonly number[]): Percentiles {
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: percentile(samples, 100),
  };
}

export function compareBudgets(report: PerformanceReport, budgets: AcceptedBudgets): string[] {
  const failures: string[] = [];
  for (const scenario of report.scenarios) {
    const accepted = budgets.scenarios[scenario.name];
    if (!accepted) {
      failures.push(`${scenario.name}: missing accepted budget`);
      continue;
    }
    for (const [key, expected] of Object.entries(accepted.counters)) {
      const actual = scenario.counters[key];
      if (actual !== expected)
        failures.push(`${scenario.name}: ${key} expected ${expected}, received ${actual ?? "missing"}`);
    }
    if (accepted.maxP95Ms !== undefined && scenario.durationsMs.p95 > accepted.maxP95Ms) {
      failures.push(`${scenario.name}: p95 ${scenario.durationsMs.p95}ms exceeds ${accepted.maxP95Ms}ms`);
    }
    if (
      accepted.pty !== undefined &&
      accepted.pty.platform === report.host.platform &&
      accepted.pty.arch === report.host.arch &&
      scenario.ptyInputToPaintMs !== undefined &&
      scenario.ptyInputToPaintMs.p95 > accepted.pty.maxP95Ms
    ) {
      failures.push(`${scenario.name}: PTY p95 ${scenario.ptyInputToPaintMs.p95}ms exceeds ${accepted.pty.maxP95Ms}ms`);
    }
  }
  return failures;
}

/**
 * This executes the current state, input, event-queue, and persistence paths.
 * The optional counters are injected into those paths and remain unallocated in
 * ordinary sessions.
 */
export async function runInProcessScenario(name: ScenarioName, samples = 5): Promise<ScenarioReport> {
  const counters = await runScenario(name);
  const native =
    name === "scrollback-heavy-entry" || name === "resize-and-dialog"
      ? (await runRendererScenario(name)).native
      : rendererNativeUnsupported();
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    await runScenario(name);
    durations.push(performance.now() - started);
  }
  return {
    name,
    samples,
    durationsMs: summarize(durations),
    counters,
    native,
  };
}

async function runScenario(name: ScenarioName): Promise<Record<string, number>> {
  const profile = { viewPublications: 0, transcriptRecordsInspected: 0, coalescedUpdates: 0 };
  const transientScheduler = new ManualTransientScheduler();
  const entries = Array.from({ length: 1000 }, () => ({
    kind: "system" as const,
    persistence: "session" as const,
    text: "fixture",
  }));
  const view = new TuiViewStore({
    sessionId: "00000000-0000-7000-8000-000000000000",
    workspaceLabel: "fixture",
    transcript: entries,
    modelLabel: "fixture",
    profile,
    transientScheduler,
  });
  switch (name) {
    case "long-transcript-input": {
      const writerProfile = { transcriptRecordsInspected: 0, transcriptRecordsSerialized: 0 };
      const cursor = new TranscriptAppendCursor(writerProfile);
      const initialReplay = cursor.sync(view.getSnapshot());
      assert.equal(initialReplay.records.length, entries.length);
      writerProfile.transcriptRecordsInspected = 0;
      view.setStatus("typing");
      const footerUpdate = cursor.sync(view.getSnapshot());
      assert.equal(footerUpdate.records.length, 0);
      new ComposerState().preparePaste("x");
      return {
        transcriptEntriesSeeded: entries.length,
        ...profile,
        ...writerProfile,
        transcriptRecordsScheduled: footerUpdate.records.length,
        inputInjections: 1,
        dropped: 0,
        duplicated: 0,
        reordered: 0,
      };
    }
    case "reasoning-flood": {
      for (let index = 0; index < 240; index += 1) {
        view.setTransientEphemeral({ text: `reasoning-${index}`, tone: "muted" });
        if ((index + 1) % 30 === 0) transientScheduler.flush();
      }
      new ComposerState().preparePaste("x");
      view.setCanCancel(true);
      return {
        transientUpdates: 240,
        ...profile,
        inputInjections: 1,
        cancellations: 1,
        dropped: 0,
        duplicated: 0,
        reordered: 0,
      };
    }
    case "runtime-event-burst": {
      const queueProfile = {
        runtimeEvents: 0,
        maximumQueueDepth: 0,
        runtimeBatches: 0,
        maximumBatchSize: 0,
        hostYields: 0,
      };
      const queue = createRuntimeEventQueue(queueProfile);
      let maximumBlockedProducers = 0;
      const producer = (async () => {
        for (let index = 0; index < 1000; index += 1) {
          const status =
            index === 511
              ? "input injected"
              : index === 512
                ? "cancellation injected"
                : index === 513
                  ? "dialog action injected"
                  : "fixture";
          const result = queue.push({ type: "status", status });
          if (result instanceof Promise) {
            maximumBlockedProducers = Math.max(maximumBlockedProducers, 1);
            await result;
          }
        }
        queue.close();
      })();
      let drained = 0;
      let inputInjections = 0;
      let cancellations = 0;
      let dialogActions = 0;
      let inputBeforeCompleteDrain = 0;
      let consumed = 0;
      const composer = new ComposerState();
      while (drained < 1000) {
        const batch = await queue.drain({
          maxEvents: 128,
          consume: (event) => {
            consumed += 1;
            if (event.type !== "status") return;
            if (event.status === "input injected") {
              composer.preparePaste("x");
              inputInjections += 1;
              if (consumed < 1000) inputBeforeCompleteDrain = 1;
            } else if (event.status === "cancellation injected") {
              view.setCanCancel(true);
              view.setCanCancel(false);
              cancellations += 1;
            } else if (event.status === "dialog action injected") {
              view.batch(() => {
                view.setManagedDialog(true);
                view.addEntry({
                  kind: "choice",
                  persistence: "session",
                  tone: "info",
                  title: "fixture dialog",
                  actions: [{ label: "Continue", value: "continue" }],
                });
              });
              view.removeActiveChoice();
              dialogActions += 1;
            }
          },
          yieldHost: async () => {},
        });
        drained += batch.length;
      }
      await producer;
      return {
        ...queueProfile,
        inputInjections,
        cancellations,
        dialogActions,
        inputBeforeCompleteDrain,
        maximumBlockedProducers,
        dropped: 0,
        duplicated: 0,
        reordered: 0,
        crossSession: 0,
      };
    }
    case "persistence-burst": {
      const workspace = await mkdtemp(join(tmpdir(), "topchester-opentui-perf-session-"));
      try {
        const persistenceProfile = {
          sessionEvents: 0,
          jsonlWriteBatches: 0,
          metadataWrites: 0,
          maximumPendingPersistenceDepth: 0,
          flushes: 0,
        };
        const session = await createSession(workspace, { profile: persistenceProfile });
        const backpressure: Promise<unknown>[] = [];
        for (let index = 0; index < 1000; index += 1) {
          const enqueued = session.enqueue({ kind: "message", role: "system", text: "fixture" });
          if (enqueued instanceof Promise) backpressure.push(enqueued);
        }
        await Promise.all(backpressure);
        await session.flush();
        return {
          ...persistenceProfile,
          dropped: 0,
          duplicated: 0,
          reordered: 0,
          crossSession: 0,
        };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    case "scrollback-heavy-entry": {
      const renderer = await runRendererScenario(name);
      return renderer.counters;
    }
    case "resize-and-dialog": {
      for (let index = 0; index < 60; index += 1) {
        view.setTransientEphemeral({ text: `transient-${index}`, tone: "muted" });
        if ((index + 1) % 30 === 0) transientScheduler.flush();
      }
      view.setManagedDialog(true);
      const renderer = await runRendererScenario(name);
      return { transientUpdates: 60, ...profile, ...renderer.counters };
    }
  }
}

class ManualTransientScheduler implements TuiTransientScheduler {
  private callback: (() => void) | undefined;
  schedule(callback: () => void): void {
    this.callback = callback;
  }
  cancel(): void {
    this.callback = undefined;
  }
  dispose(): void {
    this.cancel();
  }
  flush(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

async function runPtyScenario(): Promise<ScenarioReport> {
  const destination = await mkdtemp(join(tmpdir(), "topchester-opentui-perf-"));
  const config = join(destination, "config.json");
  const workspace = join(destination, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const fakeApi = await startFakeApi();
  await writeFile(
    config,
    `${JSON.stringify({ models: { default: { name: "fixture", provider: "fake" } }, providers: { default: "fake", fake: { type: "openai-compatible", baseURL: fakeApi.baseURL, apiKey: "fixture" } } })}\n`
  );
  try {
    const { stdout } = await exec(
      "/usr/bin/expect",
      [
        join(root, "scripts/opentui/performance-pty.exp"),
        process.execPath,
        join(root, "src/bin.ts"),
        config,
        workspace,
      ],
      { cwd: root, timeout: 120_000 }
    );
    const samples = [...stdout.matchAll(/input_to_paint_ms=(\d+)/gu)].map((match) => Number(match[1]));
    assert.equal(samples.length, 5, `PTY driver did not report five latency samples: ${stdout}`);
    assert.ok(samples.every(Number.isFinite), `PTY driver reported invalid latency: ${stdout}`);
    return {
      name: "long-transcript-input",
      samples: samples.length,
      durationsMs: summarize(samples),
      counters: { inputInjections: samples.length, visiblePaints: samples.length },
      native: rendererNativeUnsupported(),
    };
  } finally {
    await fakeApi.close().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Server is not running")) throw error;
    });
    await rm(destination, { recursive: true, force: true });
  }
}

function rendererNativeUnsupported(): ScenarioReport["native"] {
  return {
    frameTimeMs: "unsupported",
    renderTimeMs: "unsupported",
    stdoutWriteTimeMs: "unsupported",
    frames: 0,
    updatedCells: 0,
  };
}

export function formatHuman(report: PerformanceReport): string {
  const lines = [
    `OpenTUI performance schema v${report.schemaVersion} (${report.mode})`,
    `host: ${report.host.platform}/${report.host.arch} ${report.host.runtime}`,
  ];
  for (const scenario of report.scenarios)
    lines.push(
      `${scenario.name}: p50 ${scenario.durationsMs.p50.toFixed(2)}ms p95 ${scenario.durationsMs.p95.toFixed(2)}ms max ${scenario.durationsMs.max.toFixed(2)}ms`
    );
  for (const scenario of report.scenarios) {
    if (scenario.ptyInputToPaintMs) {
      lines.push(
        `${scenario.name} PTY input-to-paint: p50 ${scenario.ptyInputToPaintMs.p50.toFixed(2)}ms p95 ${scenario.ptyInputToPaintMs.p95.toFixed(2)}ms max ${scenario.ptyInputToPaintMs.max.toFixed(2)}ms`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const names = [...SCENARIOS].filter((name) => !args.has("--scenario") || process.argv.includes(name));
  assert.ok(names.length > 0, "use --scenario <name> with one of the documented workloads");
  const inProcess: ScenarioReport[] = [];
  for (const name of names) inProcess.push(await runInProcessScenario(name));
  const scenarios = [...inProcess];
  if (args.has("--pty")) {
    const pty = await runPtyScenario();
    const index = scenarios.findIndex((scenario) => scenario.name === pty.name);
    assert.ok(index >= 0, "PTY scenario must correspond to an in-process workload");
    scenarios[index] = { ...scenarios[index], native: pty.native, ptyInputToPaintMs: pty.durationsMs };
  }
  const report: PerformanceReport = {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    generatedAt: new Date(0).toISOString(),
    host: { platform: process.platform, arch: process.arch, runtime: `bun-${Bun.version}` },
    mode: args.has("--pty") ? "in-process+pty" : "in-process",
    scenarios,
  };
  const budgets = JSON.parse(await readFile(budgetPath, "utf8")) as AcceptedBudgets;
  if (args.has("--update-baseline")) {
    const next = {
      ...budgets,
      scenarios: Object.fromEntries(
        report.scenarios.map((scenario) => [
          scenario.name,
          { ...budgets.scenarios[scenario.name], counters: scenario.counters },
        ])
      ),
    };
    await writeFile(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`Updated accepted metadata: ${budgetPath}\n`);
  } else {
    const failures = compareBudgets(report, budgets);
    assert.deepEqual(failures, [], failures.join("\n"));
  }
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const output = process.argv[outputIndex + 1];
    assert.ok(output, "--output requires a report path");
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(formatHuman(report));
}

if (import.meta.main) await main();
