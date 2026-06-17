#!/usr/bin/env tsx
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dockerCompose } from "./docker.ts";
import { reportsRoot } from "./paths.ts";
import { writeRunReport, reportIndexPath } from "./report.ts";
import { loadTask, loadTasks } from "./task-loader.ts";
import { runTopchesterForTask } from "./topchester.ts";
import type { MiniBenchCommand, RunOptions, RunReport } from "./types.ts";
import { runHiddenVerifier } from "./verify.ts";
import { changedFiles, overlayCandidate, prepareWorkspace, removeRun } from "./workspace.ts";

async function main(): Promise<void> {
  const { command, args } = parseCommand(process.argv.slice(2));

  switch (command) {
    case "list":
      await listTasks();
      return;
    case "run":
      await runTask(parseRunOptions(args));
      return;
    case "verify-fixtures":
      await verifyFixtures();
      return;
    case "up":
      await dockerCompose(["up", "-d", "--build"]);
      return;
    case "down":
      await dockerCompose(["down"]);
      return;
    case "clean":
      await clean();
      return;
    case "help":
      printHelp();
      return;
  }
}

function parseCommand(args: string[]): { command: MiniBenchCommand; args: string[] } {
  const first = args[0];

  if (!first) {
    return { command: "help", args: [] };
  }

  if (["list", "run", "verify-fixtures", "up", "down", "clean", "help"].includes(first)) {
    return { command: first as MiniBenchCommand, args: args.slice(1) };
  }

  if (first === "-h" || first === "--help") {
    return { command: "help", args: [] };
  }

  return { command: "run", args };
}

function parseRunOptions(args: string[]): RunOptions {
  const options: RunOptions = {
    noAgent: false,
    keepRuns: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--task":
        options.taskId = requireValue(args, ++index, "--task");
        break;
      case "--no-agent":
        options.noAgent = true;
        break;
      case "--candidate":
        options.candidate = requireValue(args, ++index, "--candidate");
        break;
      case "--model":
        options.model = requireValue(args, ++index, "--model");
        break;
      case "--config":
        options.config = requireValue(args, ++index, "--config");
        break;
      case "--timeout":
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(requireValue(args, ++index, arg), arg);
        break;
      case "--output":
        options.output = requireValue(args, ++index, "--output");
        break;
      case "--cleanup":
        options.keepRuns = false;
        break;
      default:
        if (!options.taskId && !arg.startsWith("-")) {
          options.taskId = arg;
          break;
        }
        throw new Error(`Unknown run argument '${arg}'`);
    }
  }

  return options;
}

async function listTasks(): Promise<void> {
  const tasks = await loadTasks();

  for (const task of tasks) {
    console.log(
      `${task.definition.id}\t${task.definition.category}\t${task.definition.difficulty}\t${task.definition.name}`
    );
  }
}

async function runTask(options: RunOptions): Promise<RunReport> {
  const task = await loadTask(options.taskId ?? "task-000-basic-ts-transform");
  const prepared = await prepareWorkspace(task);
  const startedAt = Date.now();
  let candidatePath: string | undefined;
  let agent: RunReport["agent"] | undefined;

  try {
    if (options.candidate) {
      candidatePath = await overlayCandidate(task, prepared.workspacePath, options.candidate);
    }

    if (!options.noAgent) {
      const agentResult = await runTopchesterForTask({
        task,
        workspacePath: prepared.workspacePath,
        runPath: prepared.runPath,
        model: options.model,
        config: options.config,
        timeoutMs: options.timeoutMs ?? task.definition.timeoutMs,
      });

      agent = {
        exitCode: agentResult.result.exitCode,
        timedOut: agentResult.result.timedOut,
        stdoutPath: agentResult.stdoutPath,
        stderrPath: agentResult.stderrPath,
        eventsPath: agentResult.eventsPath,
        eventsSourcePath: agentResult.eventsSourcePath,
        topchesterArtifactsPath: agentResult.topchesterArtifactsPath,
        sessionEventPaths: agentResult.sessionEventPaths,
        debugLogPath: agentResult.debugLogPath,
        stdoutTail: agentResult.stdoutTail,
        stderrTail: agentResult.stderrTail,
        toolCalls: agentResult.toolCalls,
        eventCount: agentResult.eventCount,
      };
    }

    const verifier = await runHiddenVerifier({
      task,
      workspacePath: prepared.workspacePath,
      runPath: prepared.runPath,
    });
    const report: RunReport = {
      runId: prepared.runId,
      taskId: task.definition.id,
      taskName: task.definition.name,
      status: agent?.timedOut ? "agent_timeout" : verifier.passed ? "passed" : "failed",
      mode: options.noAgent ? "candidate" : "agent",
      candidate: candidatePath,
      model: options.model,
      config: options.config,
      workspacePath: prepared.workspacePath,
      runPath: prepared.runPath,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      changedFiles: await changedFiles(prepared.workspacePath, prepared.beforeHashes),
      verifier,
      agent,
    };

    const reportPath = await writeRunReport(report, options.output);
    await writeFile(reportIndexPath(), `${JSON.stringify(report, null, 2)}\n`);
    printRunResult(report, reportPath);

    if (report.status !== "passed") {
      process.exitCode = 1;
    }

    return report;
  } finally {
    if (!options.keepRuns) {
      await removeRun(prepared.runPath);
    }
  }
}

async function verifyFixtures(): Promise<void> {
  const good = await runTask({
    taskId: "task-000-basic-ts-transform",
    noAgent: true,
    candidate: "good",
    keepRuns: true,
  });
  const bad = await runTask({
    taskId: "task-000-basic-ts-transform",
    noAgent: true,
    candidate: "bad",
    keepRuns: true,
  });

  if (!good.verifier.passed) {
    throw new Error("Known-good task-000 fixture failed verifier");
  }

  if (bad.verifier.passed) {
    throw new Error("Known-bad task-000 fixture unexpectedly passed verifier");
  }

  process.exitCode = 0;
}

async function clean(): Promise<void> {
  await rm(resolve(reportsRoot, "runs"), { recursive: true, force: true });
  await mkdir(reportsRoot, { recursive: true });
  console.log("mini-bench reports cleaned");
}

function printRunResult(report: RunReport, reportPath: string): void {
  console.log(`${report.status.toUpperCase()} ${report.taskId} (${report.durationMs}ms)`);
  console.log(`report: ${reportPath}`);
  console.log(`workspace: ${report.workspacePath}`);
  for (const assertion of report.verifier.assertions) {
    console.log(
      `${assertion.passed ? "PASS" : "FAIL"} ${assertion.name}${assertion.message ? `: ${assertion.message}` : ""}`
    );
  }
}

function printHelp(): void {
  console.log("Topchester mini-bench");
  console.log("");
  console.log("Usage:");
  console.log("  pnpm mini-bench:list");
  console.log("  pnpm mini-bench run --task task-000-basic-ts-transform --no-agent --candidate good");
  console.log("  pnpm mini-bench run --task task-000-basic-ts-transform --model <model>");
  console.log("  pnpm mini-bench:verify-fixtures");
  console.log("  pnpm mini-bench up");
  console.log("  pnpm mini-bench down");
  console.log("  pnpm mini-bench clean");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
