#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { argv, cwd } from "node:process";
import { resolve } from "node:path";
import { Bench, type Task } from "tinybench";
import { Command } from "commander";
import {
  createL1ContextPack,
  createL1ContextPackFromIndex,
  loadL1KnowledgeIndex,
  stripEmptyContainers,
  type L1ContextPackOptions,
  type L1ContextPackResult,
  type LoadedL1KnowledgeIndex,
} from "../../src/knowledge/search.js";

const scriptArgv = argv[2] === "--" ? [argv[0]!, argv[1]!, ...argv.slice(3)] : argv;

type BenchmarkMode = "shared" | "fresh";

interface CliOptions {
  workspaceDir: string;
  mode: BenchmarkMode;
  query: string;
  trials: number;
  limit?: number;
  minScore?: number;
  fullL1?: boolean;
  json?: boolean;
  omitContextPack?: boolean;
}

interface BenchmarkStats {
  name: string;
  state: "completed";
  runs: number;
  expectedRuns: number;
  totalMs: number;
  latencyMs: {
    mean: number;
    min: number;
    p50: number;
    p75: number;
    p99: number;
    max: number;
    relativeMarginOfErrorPercent: number;
    samples: number;
  };
  throughputOpsPerSecond: {
    mean: number;
    p50: number;
  };
}

interface BenchmarkSummary {
  benchmark: {
    name: "l1-search";
    workspaceDir: string;
    mode: BenchmarkMode;
    query: string;
    trials: number;
    limit: number;
    minScore: number;
    setupMs: number;
    contextJsonBytes: number;
    entryCount: number;
    invalidEntryCount: number;
    relevantFileCount: number;
  };
  stats: BenchmarkStats;
  contextPack?: unknown;
  lastSummary: string;
}

const program = new Command()
  .name("l1-search-benchmark")
  .description("Benchmark Topchester L1 context-pack search.")
  .requiredOption("--workspace-dir <path>", "project directory containing topchester-kb")
  .requiredOption("--mode <mode>", "shared or fresh", parseMode)
  .requiredOption("--query <query>", "query to search")
  .requiredOption("--trials <count>", "number of measured benchmark runs", parsePositiveInteger)
  .option("--limit <count>", "maximum number of relevant files, matching `topchester kb context`", parsePositiveInteger)
  .option("--min-score <score>", "minimum match score, matching `topchester kb context`", parseNonNegativeNumber)
  .option("--full-l1", "include full raw L1 entries in the JSON context pack")
  .option("--json", "write benchmark summary as JSON")
  .option("--omit-context-pack", "omit the final contextPack from JSON output");

program.parse(scriptArgv);

const options = program.opts<CliOptions>();

try {
  await runBenchmark(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runBenchmark(options: CliOptions): Promise<void> {
  const workspaceDir = resolve(cwd(), options.workspaceDir);
  const contextOptions: L1ContextPackOptions = {
    limit: options.limit,
    minScore: options.minScore,
    includeFullL1: options.fullL1,
  };
  let sharedIndex: LoadedL1KnowledgeIndex | undefined;
  let setupMs = 0;

  if (options.mode === "shared") {
    const startedAt = performance.now();
    sharedIndex = await loadL1KnowledgeIndex(workspaceDir);
    setupMs = performance.now() - startedAt;
  }

  let lastContextPack: L1ContextPackResult | undefined;
  let lastJson = "";
  const bench = new Bench({
    name: "l1-search",
    time: 0,
    iterations: options.trials,
    warmup: false,
    retainSamples: true,
    timestampProvider: "hrtimeNow",
  });
  const taskName = `l1-search:${options.mode}`;

  if (options.mode === "shared") {
    if (!sharedIndex) {
      throw new Error("Shared mode did not load an L1 index.");
    }

    bench.add(
      taskName,
      () => {
        const result = createL1ContextPackFromIndex(sharedIndex, options.query, contextOptions);
        lastContextPack = result;
        lastJson = stringifyContextPack(result);
      },
      { async: false }
    );
  } else {
    bench.add(
      taskName,
      async () => {
        const result = await createL1ContextPack(workspaceDir, options.query, contextOptions);
        lastContextPack = result;
        lastJson = stringifyContextPack(result);
      },
      { async: true }
    );
  }

  const [task] = await bench.run();

  if (!task || !lastContextPack) {
    throw new Error("Benchmark did not produce a context pack.");
  }

  const stats = summarizeTask(task, options.trials);
  const summary: BenchmarkSummary = {
    benchmark: {
      name: "l1-search",
      workspaceDir,
      mode: options.mode,
      query: options.query,
      trials: options.trials,
      limit: lastContextPack.selection.limit,
      minScore: lastContextPack.selection.minScore,
      setupMs: round(setupMs),
      contextJsonBytes: Buffer.byteLength(lastJson, "utf8"),
      entryCount: lastContextPack.entryCount,
      invalidEntryCount: lastContextPack.invalidEntryCount,
      relevantFileCount: lastContextPack.relevantFiles.length,
    },
    stats,
    contextPack: options.omitContextPack ? undefined : stripEmptyContainers(lastContextPack),
    lastSummary: lastContextPack.summary,
  };

  if (options.json) {
    console.log(JSON.stringify(stripEmptyContainers(summary), null, 2));
    return;
  }

  printHumanSummary(summary);
}

function stringifyContextPack(result: L1ContextPackResult): string {
  return JSON.stringify(stripEmptyContainers(result), null, 2);
}

function summarizeTask(task: Task, expectedRuns: number): BenchmarkStats {
  const { result } = task;

  if (result.state !== "completed") {
    throw new Error(`Benchmark task ended with state ${result.state}.`);
  }

  if (task.runs !== expectedRuns) {
    throw new Error(`Expected ${expectedRuns} benchmark runs, but Tinybench reported ${task.runs}.`);
  }

  return {
    name: task.name,
    state: result.state,
    runs: task.runs,
    expectedRuns,
    totalMs: round(result.totalTime),
    latencyMs: {
      mean: round(result.latency.mean),
      min: round(result.latency.min),
      p50: round(result.latency.p50),
      p75: round(result.latency.p75),
      p99: round(result.latency.p99),
      max: round(result.latency.max),
      relativeMarginOfErrorPercent: round(result.latency.rme, 2),
      samples: result.latency.samplesCount,
    },
    throughputOpsPerSecond: {
      mean: round(result.throughput.mean, 2),
      p50: round(result.throughput.p50, 2),
    },
  };
}

function printHumanSummary(summary: BenchmarkSummary): void {
  const { benchmark, stats } = summary;

  console.log("L1 search benchmark");
  console.log(`workspace: ${benchmark.workspaceDir}`);
  console.log(`mode: ${benchmark.mode}`);
  console.log(`query: ${benchmark.query}`);
  console.log(`trials: ${benchmark.trials}`);
  console.log(`entries indexed: ${benchmark.entryCount}`);
  console.log(`invalid L1 entries skipped: ${benchmark.invalidEntryCount}`);
  console.log(`relevant files: ${benchmark.relevantFileCount}`);
  if (benchmark.mode === "shared") {
    console.log(`shared index setup: ${benchmark.setupMs} ms`);
  }
  console.log(`context JSON bytes: ${benchmark.contextJsonBytes}`);
  console.log("");
  console.table([
    {
      "task": stats.name,
      "runs": stats.runs,
      "mean ms": stats.latencyMs.mean,
      "p50 ms": stats.latencyMs.p50,
      "p75 ms": stats.latencyMs.p75,
      "p99 ms": stats.latencyMs.p99,
      "rme %": stats.latencyMs.relativeMarginOfErrorPercent,
      "ops/s": stats.throughputOpsPerSecond.mean,
    },
  ]);
  console.log("");
  console.log(`last summary: ${summary.lastSummary}`);
}

function parseMode(value: string): BenchmarkMode {
  if (value === "shared" || value === "fresh") {
    return value;
  }

  throw new Error("Expected mode to be `shared` or `fresh`.");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected a positive integer.");
  }

  return parsed;
}

function parseNonNegativeNumber(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Expected a non-negative number.");
  }

  return parsed;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}
