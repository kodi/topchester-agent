#!/usr/bin/env tsx
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dockerCompose, startTaskServices } from "./docker.ts";
import { reportsRoot } from "./paths.ts";
import { writeRunReport, reportIndexPath } from "./report.ts";
import { loadTask, loadTasks } from "./task-loader.ts";
import { runTopchesterForTask } from "./topchester.ts";
import { runCommand } from "./command.ts";
import type { AgentUsageSummary, MiniBenchCommand, RunOptions, RunReport } from "./types.ts";
import { runHiddenVerifier } from "./verify.ts";
import { changedFiles, overlayCandidate, prepareWorkspace, removeRun } from "./workspace.ts";

async function main(): Promise<void> {
  const { command, args } = parseCommand(process.argv.slice(2));

  switch (command) {
    case "list":
      await listTasks();
      return;
    case "run":
      await runTasks(parseRunOptions(args));
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
        addTaskId(options, requireValue(args, ++index, "--task"));
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
        if (!arg.startsWith("-")) {
          addTaskId(options, arg);
          break;
        }
        throw new Error(`Unknown run argument '${arg}'`);
    }
  }

  return options;
}

function addTaskId(options: RunOptions, taskId: string): void {
  options.taskIds = [...(options.taskIds ?? []), taskId];
  options.taskId ??= taskId;
}

async function listTasks(): Promise<void> {
  const tasks = await loadTasks();
  const rows = tasks.map((task) => [
    task.definition.id,
    task.definition.category,
    task.definition.difficulty,
    task.definition.name,
  ]);

  printTable(["Task", "Category", "Difficulty", "Name"], rows);
}

async function runTasks(options: RunOptions): Promise<RunReport[]> {
  const taskIds =
    options.taskIds && options.taskIds.length > 0 ? options.taskIds : [options.taskId ?? "task-000-basic-ts-transform"];
  if (options.output && taskIds.length > 1) {
    throw new Error("--output can only be used with a single task run");
  }

  const reports: RunReport[] = [];

  for (const [index, taskId] of taskIds.entries()) {
    console.log("");
    console.log(`${style("▶", "cyan")} ${style(`[${index + 1}/${taskIds.length}] ${taskId}`, "bold")}`);
    const report = await runTask({ ...options, taskId, taskIds: undefined });
    reports.push(report);
  }

  if (reports.length > 1) {
    const passed = reports.filter((report) => report.status === "passed").length;
    const color = passed === reports.length ? "green" : "red";
    console.log(`${style("◇ SUMMARY", "cyan")} ${style(`${passed}/${reports.length}`, color)} tasks passed`);
    printAggregateRunSummary(reports);
    printAggregateAgentSummary(reports);
  }

  if (reports.some((report) => report.status !== "passed")) {
    process.exitCode = 1;
  }

  return reports;
}

async function runTask(options: RunOptions): Promise<RunReport> {
  const task = await loadTask(options.taskId ?? "task-000-basic-ts-transform");
  console.log(`${dim("├─ preparing workspace")}`);
  const prepared = await prepareWorkspace(task);
  console.log(`${dim("│  workspace:")} ${prepared.workspacePath}`);
  const startedAt = Date.now();
  let candidatePath: string | undefined;
  let agent: RunReport["agent"] | undefined;

  try {
    if (task.definition.services.length > 0) {
      console.log(`${dim("├─ starting services:")} ${task.definition.services.join(", ")}`);
      await startTaskServices(task.definition.services);
    }

    if (task.definition.bootstrap?.script) {
      console.log(`${dim("├─ bootstrapping workspace:")} ${task.definition.bootstrap.script}`);
      const bootstrap = await runCommand("sh", ["-lc", task.definition.bootstrap.script], {
        cwd: prepared.workspacePath,
        timeoutMs: 120_000,
        progressIntervalMs: 10_000,
        onProgress: (elapsedMs) => console.log(`${dim("│  ")}bootstrap still running (${formatDuration(elapsedMs)})`),
      });
      if (bootstrap.exitCode !== 0) {
        throw new Error(
          [`bootstrap failed with exit code ${bootstrap.exitCode}`, bootstrap.stdout.trim(), bootstrap.stderr.trim()]
            .filter(Boolean)
            .join("\n")
        );
      }
    }

    if (options.candidate) {
      console.log(`${dim("├─ overlaying candidate:")} ${options.candidate}`);
      candidatePath = await overlayCandidate(task, prepared.workspacePath, options.candidate);
    }

    if (!options.noAgent) {
      console.log(
        `${dim("├─ running Topchester agent")} ${dim(`timeout=${options.timeoutMs ?? task.definition.timeoutMs}ms`)}`
      );
      const agentResult = await runTopchesterForTask({
        task,
        workspacePath: prepared.workspacePath,
        runPath: prepared.runPath,
        model: options.model,
        config: options.config,
        timeoutMs: options.timeoutMs ?? task.definition.timeoutMs,
        onProgress: (message) => console.log(`${dim("│  ")}${message}`),
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
        eventKinds: agentResult.eventKinds,
        messageRoles: agentResult.messageRoles,
        taskPlanCount: agentResult.taskPlanCount,
        todoUpdateCount: agentResult.todoUpdateCount,
        statusCount: agentResult.statusCount,
        turnCount: agentResult.turnCount,
        turnCountSource: agentResult.turnCountSource,
        usage: agentResult.usage,
      };
      console.log(`${dim("│  agent exit:")} ${agent.exitCode ?? "null"}${agent.timedOut ? " timed out" : ""}`);
    }

    console.log(`${dim("├─ running hidden verifier")}`);
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

    console.log(`${dim("├─ writing report")}`);
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
  const taskIds = [
    "task-000-basic-ts-transform",
    "ts-001-json-schema-migrator",
    "db-001-sqlite-ledger-balances",
    "db-003-postgres-order-analytics",
  ];
  console.log(`${style("◇ Fixture verification", "cyan")} ${dim(`(${taskIds.length} tasks)`)}`);

  for (const taskId of taskIds) {
    console.log("");
    console.log(`${style("▶", "cyan")} ${style(taskId, "bold")}`);
    console.log(`${dim("  good fixture should pass")}`);
    const good = await runTask({
      taskId,
      noAgent: true,
      candidate: "good",
      keepRuns: true,
    });

    console.log(`${dim("  bad fixture should fail")}`);
    const bad = await runTask({
      taskId,
      noAgent: true,
      candidate: "bad",
      keepRuns: true,
    });

    if (!good.verifier.passed) {
      throw new Error(`Known-good ${taskId} fixture failed verifier`);
    }

    if (bad.verifier.passed) {
      throw new Error(`Known-bad ${taskId} fixture unexpectedly passed verifier`);
    }
  }

  process.exitCode = 0;
  console.log("");
  console.log(`${style("✓ Fixture verification passed", "green")}`);
}

async function clean(): Promise<void> {
  await rm(resolve(reportsRoot, "runs"), { recursive: true, force: true });
  await mkdir(reportsRoot, { recursive: true });
  console.log(`${style("✓", "green")} mini-bench reports cleaned`);
}

function printRunResult(report: RunReport, reportPath: string): void {
  const passed = report.status === "passed";
  const statusIcon = passed ? "✓" : report.status === "agent_timeout" ? "⏱" : "✗";
  const statusColor = passed ? "green" : report.status === "agent_timeout" ? "yellow" : "red";

  console.log(
    `${style(statusIcon, statusColor)} ${style(report.status.toUpperCase(), statusColor)} ${style(report.taskId, "bold")} ${dim(`(${report.durationMs}ms)`)}`
  );
  console.log(`${dim("├─ report:")} ${reportPath}`);
  console.log(`${dim("└─ workspace:")} ${report.workspacePath}`);
  for (const assertion of report.verifier.assertions) {
    const assertionIcon = assertion.passed ? style("✓", "green") : style("✗", "red");
    console.log(`  ${assertionIcon} ${assertion.name}${assertion.message ? dim(`: ${assertion.message}`) : ""}`);
  }
  if (report.agent) {
    printAgentEventSummary(report.agent);
  }
}

function printAgentEventSummary(agent: NonNullable<RunReport["agent"]>): void {
  const toolTotal = Object.values(agent.toolCalls).reduce((sum, count) => sum + count, 0);
  const messageTotal = Object.values(agent.messageRoles).reduce((sum, count) => sum + count, 0);
  console.log(
    `  ${style("◇", "cyan")} events: ${agent.eventCount}; turns: ${agent.turnCount}; cost: ${formatCostUsdForCli(agent.usage.costUsd)}; tools: ${toolTotal}; messages: ${messageTotal}; plans: ${agent.taskPlanCount}; todos: ${agent.todoUpdateCount}; statuses: ${agent.statusCount}`
  );
  console.log(`    tokens: ${formatUsage(agent.usage)}`);
  if (Object.keys(agent.toolCalls).length > 0) {
    console.log(`    tools: ${formatCountMap(agent.toolCalls)}`);
  }
  if (Object.keys(agent.messageRoles).length > 0) {
    console.log(`    messages: ${formatCountMap(agent.messageRoles)}`);
  }
  if (Object.keys(agent.eventKinds).length > 0) {
    console.log(`    event kinds: ${formatCountMap(agent.eventKinds)}`);
  }
}

function printAggregateRunSummary(reports: RunReport[]): void {
  const startedAt = Math.min(...reports.map((report) => Date.parse(report.startedAt)).filter(Number.isFinite));
  const finishedAt = Math.max(...reports.map((report) => Date.parse(report.finishedAt)).filter(Number.isFinite));
  const wallTimeMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? finishedAt - startedAt : undefined;
  const taskTimeMs = reports.reduce((sum, report) => sum + report.durationMs, 0);
  const totalAssertions = reports.reduce((sum, report) => sum + report.verifier.assertions.length, 0);
  const passedAssertions = reports.reduce(
    (sum, report) => sum + report.verifier.assertions.filter((assertion) => assertion.passed).length,
    0
  );
  const changedFileCount = reports.reduce((sum, report) => sum + report.changedFiles.length, 0);
  const timeoutCount = reports.filter((report) => report.status === "agent_timeout").length;
  const agents = reports
    .map((report) => report.agent)
    .filter((agent): agent is NonNullable<RunReport["agent"]> => Boolean(agent));
  const turnCount = agents.reduce((sum, agent) => sum + agent.turnCount, 0);
  const usage = sumUsage(agents.map((agent) => agent.usage));

  console.log(
    `${style("◇ RUN TOTAL", "cyan")} wall: ${wallTimeMs === undefined ? "n/a" : formatDuration(wallTimeMs)}; task time: ${formatDuration(taskTimeMs)}; turns: ${turnCount}; cost: ${formatCostUsdForCli(usage.costUsd)}`
  );
  console.log(
    `  assertions: ${passedAssertions}/${totalAssertions}; changed files: ${changedFileCount}; timeouts: ${timeoutCount}; tokens: ${formatUsage(usage)}`
  );
}

function printAggregateAgentSummary(reports: RunReport[]): void {
  const agents = reports
    .map((report) => report.agent)
    .filter((agent): agent is NonNullable<RunReport["agent"]> => Boolean(agent));
  if (agents.length === 0) {
    return;
  }

  const eventCount = agents.reduce((sum, agent) => sum + agent.eventCount, 0);
  const toolCalls = mergeCountMaps(agents.map((agent) => agent.toolCalls));
  const messageRoles = mergeCountMaps(agents.map((agent) => agent.messageRoles));
  const eventKinds = mergeCountMaps(agents.map((agent) => agent.eventKinds));
  const taskPlanCount = agents.reduce((sum, agent) => sum + agent.taskPlanCount, 0);
  const todoUpdateCount = agents.reduce((sum, agent) => sum + agent.todoUpdateCount, 0);
  const statusCount = agents.reduce((sum, agent) => sum + agent.statusCount, 0);
  const turnCount = agents.reduce((sum, agent) => sum + agent.turnCount, 0);
  const usage = sumUsage(agents.map((agent) => agent.usage));
  const toolTotal = Object.values(toolCalls).reduce((sum, count) => sum + count, 0);
  const messageTotal = Object.values(messageRoles).reduce((sum, count) => sum + count, 0);

  console.log(
    `${style("◇ AGENT EVENTS", "cyan")} events: ${eventCount}; turns: ${turnCount}; cost: ${formatCostUsdForCli(usage.costUsd)}; tools: ${toolTotal}; messages: ${messageTotal}; plans: ${taskPlanCount}; todos: ${todoUpdateCount}; statuses: ${statusCount}`
  );
  console.log(`  tokens: ${formatUsage(usage)}`);
  if (Object.keys(toolCalls).length > 0) {
    console.log(`  tools: ${formatCountMap(toolCalls)}`);
  }
  if (Object.keys(messageRoles).length > 0) {
    console.log(`  messages: ${formatCountMap(messageRoles)}`);
  }
  if (Object.keys(eventKinds).length > 0) {
    console.log(`  event kinds: ${formatCountMap(eventKinds)}`);
  }
}

function mergeCountMaps(maps: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    for (const [key, count] of Object.entries(map)) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

function sumUsage(usages: AgentUsageSummary[]): AgentUsageSummary {
  const total: AgentUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  for (const usage of usages) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.costUsd !== undefined) {
      total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
    }
  }

  return total;
}

function formatUsage(usage: AgentUsageSummary): string {
  return [
    `input=${formatInteger(usage.inputTokens)}`,
    `output=${formatInteger(usage.outputTokens)}`,
    `total=${formatInteger(usage.totalTokens)}`,
    `cacheRead=${formatInteger(usage.cacheReadTokens)}`,
    `cacheWrite=${formatInteger(usage.cacheWriteTokens)}`,
  ].join(", ");
}

function formatCostUsd(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }

  if (value === 0) {
    return "$0.00";
  }

  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function formatCostUsdForCli(value: number | undefined): string {
  const formatted = formatCostUsd(value);
  return value === undefined ? dim(formatted) : style(formatted, "green");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCountMap(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function printHelp(): void {
  console.log("Topchester mini-bench");
  console.log("");
  console.log("Usage:");
  console.log("  pnpm mini-bench:list");
  console.log("  pnpm mini-bench run --task task-000-basic-ts-transform --no-agent --candidate good");
  console.log("  pnpm mini-bench run --task task-000-basic-ts-transform --task another-task");
  console.log("  pnpm mini-bench run --task task-000-basic-ts-transform --model <model>");
  console.log("  pnpm mini-bench:verify-fixtures");
  console.log("  pnpm mini-bench up");
  console.log("  pnpm mini-bench down");
  console.log("  pnpm mini-bench clean");
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const line = (left: string, join: string, right: string) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(join)}${right}`;
  const row = (values: string[], color?: Color) =>
    `│ ${values
      .map((value, index) => {
        const padded = value.padEnd(widths[index] ?? 0);
        return color ? style(padded, color) : padded;
      })
      .join(" │ ")} │`;

  console.log(line("┌", "┬", "┐"));
  console.log(row(headers, "bold"));
  console.log(line("├", "┼", "┤"));
  for (const values of rows) {
    console.log(row(values));
  }
  console.log(line("└", "┴", "┘"));
}

type Color = "bold" | "cyan" | "green" | "red" | "yellow" | "dim";

function style(value: string, color: Color): string {
  if (process.env.NO_COLOR) {
    return value;
  }

  const codes: Record<Color, [number, number]> = {
    bold: [1, 22],
    cyan: [36, 39],
    green: [32, 39],
    red: [31, 39],
    yellow: [33, 39],
    dim: [2, 22],
  };
  const [open, close] = codes[color];
  return `\u001B[${open}m${value}\u001B[${close}m`;
}

function dim(value: string): string {
  return style(value, "dim");
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
