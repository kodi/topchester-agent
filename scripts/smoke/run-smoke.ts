#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { startFakeApi } from "./fake-api.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..");
const cliPath = join(repoRoot, "src/bin.ts");
const tsxPath = join(repoRoot, "node_modules/.bin/tsx");
const scenariosRoot = join(import.meta.dirname, "scenarios");

const expectedContentSchema = z.object({
  file: z.string(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  matches: z.string().optional(),
});

const bootstrapFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const gitChangeSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.union([z.string(), z.array(z.string()).min(1)]),
  template: z.string().optional().default("template"),
  bootstrapFiles: z.array(bootstrapFileSchema).optional().default([]),
  gitBootstrap: z
    .object({
      initialCommit: z.boolean().optional().default(true),
      staged: z.array(gitChangeSchema).optional().default([]),
      unstaged: z.array(gitChangeSchema).optional().default([]),
      untracked: z.array(gitChangeSchema).optional().default([]),
      deleted: z.array(z.string()).optional().default([]),
    })
    .optional(),
  timeoutMs: z.number().int().positive().optional().default(120_000),
  requiredToolCalls: z.array(z.string()).optional().default([]),
  forbiddenToolCalls: z.array(z.string()).optional().default([]),
  expectedFiles: z.array(z.string()).optional().default([]),
  expectedMissingFiles: z.array(z.string()).optional().default([]),
  expectedContent: z.array(expectedContentSchema).optional().default([]),
  expectedOutputContains: z.array(z.string()).optional().default([]),
  expectedKb: z
    .object({
      statusAfter: z.string().optional(),
    })
    .optional(),
  expectedTaskPlan: z
    .object({
      updateCount: z.number().int().min(0).optional(),
      lastStatus: z.enum(["empty", "completed", "in_progress", "pending"]).optional(),
      lastActiveItem: z.string().optional(),
    })
    .optional(),
  expectedSubagent: z
    .object({
      completed: z.boolean().optional().default(true),
      agentProfileId: z.string().optional(),
      requiredChildToolCalls: z.array(z.string()).optional().default([]),
      expectedResultContains: z.array(z.string()).optional().default([]),
      expectedChildMessagesContain: z.array(z.string()).optional().default([]),
    })
    .optional(),
  expectedGit: z
    .object({
      stagedPaths: z.array(z.string()).optional(),
      unstagedPaths: z.array(z.string()).optional(),
      untrackedPaths: z.array(z.string()).optional(),
      latestCommitSubject: z.string().optional(),
      latestCommitPaths: z.array(z.string()).optional(),
    })
    .optional(),
});

type Scenario = z.infer<typeof scenarioSchema>;

interface CliOptions {
  scenarios: string[];
  trials: number;
  retries?: number;
  model?: string;
  configPath?: string;
  timeoutMs?: number;
  fakeApi: boolean;
  keepWorkspaces: boolean;
  dryRun: boolean;
  parallel: number;
  output?: string;
  toolProtocol?: "auto" | "native" | "text-json" | "text-xml";
}

interface TrialResult {
  scenarioId: string;
  trial: number;
  attempt: number;
  status: "passed" | "failed";
  workspace: string;
  outputDir: string;
  failures: string[];
  durationMs: number;
  attemptsUsed: number;
  retriesUsed: number;
  maxRetries?: number;
  attempts?: TrialAttemptSummary[];
  toolProtocol?: string;
  nativeToolCallCount: number;
  textJsonToolCallCount: number;
  textXmlToolCallCount: number;
  providerRejectedTools: boolean;
  fallbackReason?: string;
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
  taskPlanUpdateCount: number;
  lastTaskPlanStatus?: "empty" | "completed" | "in_progress" | "pending";
  lastTaskPlanActiveItem?: string;
}

interface TrialAttemptSummary {
  attempt: number;
  status: "passed" | "failed";
  workspace: string;
  outputDir: string;
  failures: string[];
  durationMs: number;
  toolProtocol?: string;
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
}

interface JsonLine {
  type?: string;
  runId?: string;
  sessionId?: string;
  event?: {
    type?: string;
    call?: {
      tool?: string;
    };
    plan?: {
      items?: unknown;
    };
    status?: Record<string, unknown>;
  };
}

interface ProtocolMetadata {
  toolProtocol?: string;
  nativeToolCallCount: number;
  textJsonToolCallCount: number;
  textXmlToolCallCount: number;
  providerRejectedTools: boolean;
  fallbackReason?: string;
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
  taskPlanUpdateCount: number;
  lastTaskPlanStatus?: "empty" | "completed" | "in_progress" | "pending";
  lastTaskPlanActiveItem?: string;
}

class DryRunComplete extends Error {}

const options = parseArgs(process.argv.slice(2));
const outputRoot = resolve(options.output ?? join(tmpdir(), `topchester-smoke-${Date.now()}`, "report.json"));
const artifactRoot = join(dirname(outputRoot), "artifacts");
let fakeApi: Awaited<ReturnType<typeof startFakeApi>> | undefined;
const suiteStartedAt = Date.now();

try {
  if (options.fakeApi && options.configPath) {
    throw new Error("--config cannot be combined with --fake-api because fake API runs generate their own config.");
  }

  if (options.fakeApi) {
    fakeApi = await startFakeApi();
  }

  const scenarios = await loadScenarios(options.scenarios);

  if (options.dryRun) {
    console.log(`loaded ${scenarios.length} smoke scenario${scenarios.length === 1 ? "" : "s"}`);
    for (const scenario of scenarios) {
      console.log(`${scenario.id}: ${scenario.name}`);
    }
    process.exitCode = 0;
    throw new DryRunComplete();
  }

  const results: TrialResult[] = [];
  const jobs =
    options.retries === undefined
      ? scenarios.flatMap((scenario) =>
          Array.from({ length: options.trials }, (_, index) => ({ scenario, trial: index + 1 }))
        )
      : scenarios.map((scenario) => ({ scenario, trial: 1 }));

  results.push(
    ...(await runWithConcurrency(jobs, Math.max(1, options.parallel), (job) =>
      runTrialWithRetries(job.scenario, job.trial, options, fakeApi?.baseURL).then((result) => {
        console.log(formatTrialLine(result));
        return result;
      })
    ))
  );

  await mkdir(dirname(outputRoot), { recursive: true });
  await writeFile(
    outputRoot,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fakeApi: options.fakeApi,
        model: options.model,
        configPath: options.configPath,
        results,
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(dirname(outputRoot), "summary.md"), formatSummary(results));

  const failures = results.filter((result) => result.status === "failed");
  console.log("");
  console.log(`report: ${outputRoot}`);
  console.log(`artifacts: ${artifactRoot}`);
  console.log(formatConsoleSummary(results));
  console.log(`elapsed: ${formatElapsed(Date.now() - suiteStartedAt)}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof DryRunComplete)) {
    throw error;
  }
} finally {
  await fakeApi?.close();
}

async function runTrial(
  scenario: Scenario,
  trial: number,
  attempt: number,
  options: CliOptions,
  fakeApiBaseURL: string | undefined
): Promise<TrialResult> {
  const startedAt = Date.now();
  const trialId = `${scenario.id}/trial-${trial}${options.retries === undefined ? "" : `/attempt-${attempt}`}`;
  const outputDir =
    options.retries === undefined
      ? join(artifactRoot, scenario.id, `trial-${trial}`)
      : join(artifactRoot, scenario.id, `trial-${trial}`, `attempt-${attempt}`);
  const workspace = await mkdtemp(join(tmpdir(), `topchester-smoke-${scenario.id}-${trial}-${attempt}-`));
  const templatePath = join(scenariosRoot, scenario.id, scenario.template);
  const failures: string[] = [];
  let sessionId: string | undefined;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const runIds: string[] = [];

  await mkdir(outputDir, { recursive: true });
  await copyTemplate(templatePath, workspace);
  await applyBootstrapFiles(workspace, scenario.bootstrapFiles);
  await bootstrapGit(workspace, scenario.gitBootstrap);

  const configPath = fakeApiBaseURL
    ? await writeFakeApiConfig(outputDir, fakeApiBaseURL, options.model, options.toolProtocol)
    : options.configPath;
  const timeoutMs = options.timeoutMs ?? scenario.timeoutMs;
  const prompts = Array.isArray(scenario.prompt) ? scenario.prompt : [scenario.prompt];

  for (let index = 0; index < prompts.length; index += 1) {
    const eventsPath = join(outputDir, `events-${index + 1}.jsonl`);
    const result = await runTopchester({
      workspace,
      configPath,
      prompt: prompts[index]!,
      timeoutMs,
      model: fakeApiBaseURL ? undefined : options.model,
      toolProtocol: options.toolProtocol,
      sessionId,
      eventsPath,
    });
    stdoutParts.push(result.stdout);
    stderrParts.push(result.stderr);

    if (result.exitCode !== 0) {
      failures.push(`${trialId} prompt ${index + 1} exited with code ${result.exitCode}`);
    }

    const events = await readJsonLines<JsonLine>(eventsPath);
    sessionId = sessionId ?? events.find((event) => event.sessionId)?.sessionId;
    runIds.push(...events.map((event) => event.runId).filter((runId): runId is string => Boolean(runId)));
  }

  await writeFile(join(outputDir, "stdout.log"), stdoutParts.join("\n"));
  await writeFile(join(outputDir, "stderr.log"), stderrParts.join("\n"));
  await collectGlobalLogs(workspace, runIds, outputDir, failures);
  const protocolMetadata = await readProtocolMetadata(outputDir);
  await assertScenario(scenario, workspace, outputDir, stdoutParts.join("\n"), failures);

  if (options.keepWorkspaces) {
    console.log(`${trialId} workspace: ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    scenarioId: scenario.id,
    trial,
    attempt,
    status: failures.length === 0 ? "passed" : "failed",
    workspace,
    outputDir,
    failures,
    durationMs: Date.now() - startedAt,
    attemptsUsed: 1,
    retriesUsed: 0,
    ...protocolMetadata,
  };
}

async function runTrialWithRetries(
  scenario: Scenario,
  trial: number,
  options: CliOptions,
  fakeApiBaseURL: string | undefined
): Promise<TrialResult> {
  if (options.retries === undefined) {
    return runTrial(scenario, trial, 1, options, fakeApiBaseURL);
  }

  const maxAttempts = options.retries + 1;
  const attempts: TrialResult[] = [];
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runTrial(scenario, trial, attempt, options, fakeApiBaseURL);
    attempts.push(result);

    if (result.status === "passed") {
      break;
    }
  }

  const successfulAttempt = attempts.find((result) => result.status === "passed");
  const finalAttempt = successfulAttempt ?? attempts.at(-1);

  if (!finalAttempt) {
    throw new Error(`No attempt result produced for ${scenario.id} trial ${trial}.`);
  }

  const attemptTokens = sumTokenCounts(attempts);

  return {
    ...finalAttempt,
    status: successfulAttempt ? "passed" : "failed",
    failures: successfulAttempt ? [] : finalAttempt.failures,
    durationMs: Date.now() - startedAt,
    attemptsUsed: attempts.length,
    retriesUsed: attempts.length - 1,
    maxRetries: options.retries,
    ...attemptTokens,
    attempts: attempts.map((attemptResult) => ({
      attempt: attemptResult.attempt,
      status: attemptResult.status,
      workspace: attemptResult.workspace,
      outputDir: attemptResult.outputDir,
      failures: attemptResult.failures,
      durationMs: attemptResult.durationMs,
      inputTokenCount: attemptResult.inputTokenCount,
      outputTokenCount: attemptResult.outputTokenCount,
      totalTokenCount: attemptResult.totalTokenCount,
      ...(attemptResult.costUsd === undefined ? {} : { costUsd: attemptResult.costUsd }),
      ...(attemptResult.toolProtocol ? { toolProtocol: attemptResult.toolProtocol } : {}),
    })),
  };
}

async function runTopchester(options: {
  workspace: string;
  configPath?: string;
  prompt: string;
  timeoutMs: number;
  model?: string;
  toolProtocol?: CliOptions["toolProtocol"];
  sessionId?: string;
  eventsPath: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [cliPath];

  if (options.configPath) {
    args.push("--config", options.configPath);
  }

  args.push("--workspace", options.workspace);

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  args.push("run", "--timeout", String(options.timeoutMs), "--json", "--output-json", options.eventsPath);

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(options.prompt);

  try {
    const result = await execFileAsync(tsxPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        TOPCHESTER_CONFIG: "",
        TOPCHESTER_LOG_FILE: "",
        TOPCHESTER_LOG_LEVEL: "debug",
        TOPCHESTER_TOOL_PROTOCOL: options.toolProtocol ?? "",
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (isExecError(error)) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }

    throw error;
  }
}

async function assertScenario(
  scenario: Scenario,
  workspace: string,
  outputDir: string,
  stdout: string,
  failures: string[]
): Promise<void> {
  const logEvents = await readJsonLines<Record<string, unknown>>(join(outputDir, "topchester.log"));
  const calledTools = new Set(
    logEvents
      .filter((event) => event.event === "tool_call")
      .map((event) => event.tool)
      .filter((tool): tool is string => typeof tool === "string")
  );

  for (const tool of scenario.requiredToolCalls) {
    if (!calledTools.has(tool)) {
      failures.push(`expected tool ${tool} was not called`);
    }
  }

  for (const tool of scenario.forbiddenToolCalls) {
    if (calledTools.has(tool)) {
      failures.push(`forbidden tool ${tool} was called`);
    }
  }

  for (const file of scenario.expectedFiles) {
    await expectFileExists(workspace, file, failures);
  }

  for (const file of scenario.expectedMissingFiles) {
    await expectFileMissing(workspace, file, failures);
  }

  for (const expectation of scenario.expectedContent) {
    await expectFileContent(workspace, expectation, failures);
  }

  for (const text of scenario.expectedOutputContains) {
    if (!stdout.includes(text)) {
      failures.push(`stdout did not contain ${JSON.stringify(text)}`);
    }
  }

  if (logEvents.some((event) => event.event === "tool_error" || event.level === 50)) {
    failures.push("global log contains a tool or runtime error");
  }

  if (scenario.expectedKb?.statusAfter === "needs_sync") {
    const sawDirtyWrite = logEvents.some(
      (event) =>
        (event.event === "file_edit" || event.event === "file_create" || event.event === "file_overwrite") &&
        event.kbState === "needs_sync"
    );

    if (!sawDirtyWrite) {
      failures.push("expected KB state needs_sync after file change");
    }
  }

  await expectTaskPlanState(outputDir, scenario.expectedTaskPlan, failures);
  await expectSubagentState(workspace, outputDir, scenario.expectedSubagent, failures);
  await expectGitState(workspace, scenario.expectedGit, failures);
}

async function expectTaskPlanState(
  outputDir: string,
  expectation: Scenario["expectedTaskPlan"],
  failures: string[]
): Promise<void> {
  if (!expectation) {
    return;
  }

  const taskPlanEvents = await readTaskPlanJsonEvents(outputDir);
  const lastTaskPlan = taskPlanEvents.at(-1);
  const lastActiveItem = lastTaskPlan?.items.find((item) => item.status === "in_progress")?.text;

  if (expectation.updateCount !== undefined && taskPlanEvents.length !== expectation.updateCount) {
    failures.push(`task plan update count was ${taskPlanEvents.length}, expected ${expectation.updateCount}`);
  }

  if (expectation.lastStatus !== undefined) {
    const actualStatus = lastTaskPlan ? summarizeTaskPlanStatus(lastTaskPlan.items) : "empty";

    if (actualStatus !== expectation.lastStatus) {
      failures.push(`last task plan status was ${actualStatus}, expected ${expectation.lastStatus}`);
    }
  }

  if (expectation.lastActiveItem !== undefined && lastActiveItem !== expectation.lastActiveItem) {
    failures.push(
      `last task plan active item was ${JSON.stringify(lastActiveItem)}, expected ${JSON.stringify(expectation.lastActiveItem)}`
    );
  }
}

async function expectSubagentState(
  workspace: string,
  outputDir: string,
  expectation: Scenario["expectedSubagent"],
  failures: string[]
): Promise<void> {
  if (!expectation) {
    return;
  }

  const runtimeEvents = await readRuntimeJsonEvents(outputDir);
  const started = runtimeEvents.filter((event) => event.type === "subagent_started");
  const completed = runtimeEvents.filter((event) => event.type === "subagent_completed");
  const failed = runtimeEvents.filter((event) => event.type === "subagent_failed");
  const childEvents = runtimeEvents.filter((event) => event.type === "subagent_event");

  if (started.length === 0) {
    failures.push("expected at least one subagent_started event");
    return;
  }

  if (expectation.completed && completed.length === 0) {
    failures.push("expected at least one subagent_completed event");
  }

  if (expectation.completed && failed.length > 0) {
    failures.push(`expected no subagent_failed events, saw ${failed.length}`);
  }

  const childSessionIds = started
    .map((event) => getStringField(event, "sessionId"))
    .filter((id): id is string => Boolean(id));

  for (const childSessionId of childSessionIds) {
    await expectChildSessionMetadata(workspace, childSessionId, started, expectation, failures);
  }

  for (const tool of expectation.requiredChildToolCalls) {
    const sawTool = childEvents.some((event) => {
      const childEvent = getRecordField(event, "event");
      const call = getRecordField(childEvent, "call");
      return getStringField(childEvent, "type") === "tool_call" && getStringField(call, "tool") === tool;
    });

    if (!sawTool) {
      failures.push(`expected child tool ${tool} was not called`);
    }
  }

  for (const text of expectation.expectedResultContains) {
    const sawResult = completed.some((event) => getStringField(event, "result")?.includes(text));

    if (!sawResult) {
      failures.push(`subagent completed result did not contain ${JSON.stringify(text)}`);
    }
  }

  for (const text of expectation.expectedChildMessagesContain) {
    const sawMessage = childEvents.some((event) => {
      const childEvent = getRecordField(event, "event");
      return (
        getStringField(childEvent, "type") === "message" &&
        getStringField(childEvent, "role") === "assistant" &&
        Boolean(getStringField(childEvent, "text")?.includes(text))
      );
    });

    if (!sawMessage) {
      failures.push(`subagent child messages did not contain ${JSON.stringify(text)}`);
    }
  }
}

async function expectChildSessionMetadata(
  workspace: string,
  childSessionId: string,
  startedEvents: Record<string, unknown>[],
  expectation: NonNullable<Scenario["expectedSubagent"]>,
  failures: string[]
): Promise<void> {
  const metadataPath = join(workspace, ".agents", "topchester", "sessions", childSessionId, "metadata.json");
  const raw = await readFile(metadataPath, "utf8").catch(() => undefined);

  if (raw === undefined) {
    failures.push(`expected child session metadata for ${childSessionId}`);
    return;
  }

  const metadata = JSON.parse(raw) as Record<string, unknown>;
  const started = startedEvents.find((event) => getStringField(event, "sessionId") === childSessionId);
  const parentSessionId = getStringField(started, "parentSessionId");

  if (getStringField(metadata, "source") !== "subagent") {
    failures.push(`child session ${childSessionId} source was not subagent`);
  }

  if (parentSessionId && getStringField(metadata, "parentSessionId") !== parentSessionId) {
    failures.push(`child session ${childSessionId} parentSessionId did not match subagent_started`);
  }

  if (expectation.agentProfileId && getStringField(metadata, "agentProfileId") !== expectation.agentProfileId) {
    failures.push(
      `child session ${childSessionId} agentProfileId was ${JSON.stringify(getStringField(metadata, "agentProfileId"))}, expected ${JSON.stringify(expectation.agentProfileId)}`
    );
  }
}

async function readRuntimeJsonEvents(outputDir: string): Promise<Record<string, unknown>[]> {
  const eventFiles = (await readdir(outputDir))
    .filter((entry) => /^events-\d+\.jsonl$/u.test(entry))
    .sort((left, right) => left.localeCompare(right));
  const events = (await Promise.all(eventFiles.map((entry) => readJsonLines<JsonLine>(join(outputDir, entry))))).flat();

  return events.map((entry) => entry.event).filter(isRecord);
}

function getRecordField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[field];
  return isRecord(child) ? child : undefined;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[field];
  return typeof child === "string" ? child : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function collectGlobalLogs(
  workspace: string,
  runIds: string[],
  outputDir: string,
  failures: string[]
): Promise<void> {
  const logPath = join(workspace, ".agents", "topchester", "logs", "topchester.log");
  const raw = await readFile(logPath, "utf8").catch(() => "");
  const runIdSet = new Set(runIds);
  const lines = raw
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as { runId?: string };
        return parsed.runId ? runIdSet.has(parsed.runId) : false;
      } catch {
        return false;
      }
    });

  if (runIdSet.size > 0 && lines.length === 0) {
    failures.push("no global log lines found for run id");
  }

  await writeFile(join(outputDir, "topchester.log"), `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
}

async function expectFileExists(workspace: string, path: string, failures: string[]): Promise<void> {
  await stat(join(workspace, path)).catch(() => {
    failures.push(`expected file ${path} to exist`);
  });
}

async function expectFileMissing(workspace: string, path: string, failures: string[]): Promise<void> {
  await stat(join(workspace, path))
    .then(() => {
      failures.push(`expected file ${path} to be missing`);
    })
    .catch(() => undefined);
}

async function expectFileContent(
  workspace: string,
  expectation: z.infer<typeof expectedContentSchema>,
  failures: string[]
): Promise<void> {
  const path = join(workspace, expectation.file);
  const content = await readFile(path, "utf8").catch(() => undefined);

  if (content === undefined) {
    failures.push(`expected file ${expectation.file} to exist`);
    return;
  }

  if (expectation.contains !== undefined && !content.includes(expectation.contains)) {
    failures.push(`${expectation.file} did not contain ${JSON.stringify(expectation.contains)}`);
  }

  if (expectation.notContains !== undefined && content.includes(expectation.notContains)) {
    failures.push(`${expectation.file} contained ${JSON.stringify(expectation.notContains)}`);
  }

  if (expectation.matches !== undefined && !new RegExp(expectation.matches, "u").test(content)) {
    failures.push(`${expectation.file} did not match ${expectation.matches}`);
  }
}

async function loadScenarios(filters: readonly string[]): Promise<Scenario[]> {
  const entries = await readdir(scenariosRoot, { withFileTypes: true });
  const allScenarios: Scenario[] = [];

  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const configPath = join(scenariosRoot, entry.name, "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const scenario = scenarioSchema.parse(raw);

    if (scenario.id !== entry.name) {
      throw new Error(`Scenario ${entry.name} config id must match folder name.`);
    }

    allScenarios.push(scenario);
  }

  if (allScenarios.length === 0) {
    throw new Error("No smoke scenarios found.");
  }

  if (filters.length === 0) {
    return allScenarios;
  }

  const selectedIds = resolveScenarioFilters(
    filters,
    allScenarios.map((scenario) => scenario.id)
  );
  const selected = allScenarios.filter((scenario) => selectedIds.has(scenario.id));

  return selected;
}

function resolveScenarioFilters(filters: readonly string[], scenarioIds: readonly string[]): Set<string> {
  const selected = new Set<string>();

  for (const filter of filters) {
    if (scenarioIds.includes(filter)) {
      selected.add(filter);
      continue;
    }

    const matches = scenarioIds.filter((scenarioId) => scenarioId.startsWith(filter));

    if (matches.length === 0) {
      throw new Error(`No scenario found for ${filter}.`);
    }

    if (matches.length > 1) {
      throw new Error(`Scenario filter ${filter} is ambiguous: ${matches.join(", ")}.`);
    }

    selected.add(matches[0]!);
  }

  return selected;
}

async function copyTemplate(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}

async function applyBootstrapFiles(
  workspace: string,
  files: Array<z.infer<typeof bootstrapFileSchema>>
): Promise<void> {
  for (const file of files) {
    const path = join(workspace, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

async function bootstrapGit(workspace: string, bootstrap: Scenario["gitBootstrap"]): Promise<void> {
  if (!bootstrap) {
    return;
  }

  await git(workspace, ["init"]);
  await git(workspace, ["config", "user.name", "Topchester Smoke"]);
  await git(workspace, ["config", "user.email", "topchester-smoke@example.test"]);

  if (bootstrap.initialCommit) {
    await git(workspace, ["add", "-A", "--"]);
    await git(workspace, ["commit", "--allow-empty", "-m", "Initial smoke commit"]);
  }

  for (const file of bootstrap.staged) {
    await writeWorkspaceFile(workspace, file.path, file.content);
    await git(workspace, ["add", "--", file.path]);
  }

  for (const file of bootstrap.unstaged) {
    await writeWorkspaceFile(workspace, file.path, file.content);
  }

  for (const file of bootstrap.untracked) {
    await writeWorkspaceFile(workspace, file.path, file.content);
  }

  for (const path of bootstrap.deleted) {
    await rm(join(workspace, path), { force: true });
  }
}

async function writeWorkspaceFile(workspace: string, path: string, content: string): Promise<void> {
  const target = join(workspace, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeFakeApiConfig(
  outputDir: string,
  baseURL: string,
  model: string | undefined,
  toolProtocol: CliOptions["toolProtocol"]
): Promise<string> {
  const configPath = join(outputDir, "topchester-smoke.config.jsonc");
  const modelId = model ?? "topchester-smoke-fake";
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        models: {
          "default": {
            name: modelId,
            provider: "fake",
          },
          "kb.summarize": {
            name: modelId,
            provider: "fake",
          },
        },
        providers: {
          default: "fake",
          fake: {
            type: "openai-compatible",
            baseURL,
            apiKey: "fake",
            ...(toolProtocol ? { toolProtocol } : {}),
          },
        },
      },
      null,
      2
    )}\n`
  );
  return configPath;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8").catch(() => "");

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function expectGitState(
  workspace: string,
  expectation: Scenario["expectedGit"],
  failures: string[]
): Promise<void> {
  if (!expectation) {
    return;
  }

  const status = parseGitPorcelain((await git(workspace, ["status", "--porcelain=v1", "-z", "--"])).stdout);

  if (expectation.stagedPaths) {
    expectSamePaths(status.stagedPaths, expectation.stagedPaths, "staged Git paths", failures);
  }

  if (expectation.unstagedPaths) {
    expectSamePaths(status.unstagedPaths, expectation.unstagedPaths, "unstaged Git paths", failures);
  }

  if (expectation.untrackedPaths) {
    expectSamePaths(status.untrackedPaths, expectation.untrackedPaths, "untracked Git paths", failures);
  }

  if (expectation.latestCommitSubject) {
    const subject = (await git(workspace, ["log", "-n", "1", "--pretty=format:%s"])).stdout.trim();

    if (subject !== expectation.latestCommitSubject) {
      failures.push(
        `latest commit subject was ${JSON.stringify(subject)}, expected ${JSON.stringify(expectation.latestCommitSubject)}`
      );
    }
  }

  if (expectation.latestCommitPaths) {
    const paths = (await git(workspace, ["show", "--name-only", "--pretty=format:", "HEAD"])).stdout
      .split("\n")
      .filter(Boolean);
    expectSamePaths(paths, expectation.latestCommitPaths, "latest commit paths", failures);
  }
}

function parseGitPorcelain(output: string): {
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
} {
  const stagedPaths: string[] = [];
  const unstagedPaths: string[] = [];
  const untrackedPaths: string[] = [];

  for (const entry of output.split("\0").filter(Boolean)) {
    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const path = entry.slice(3);

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedPaths.push(path);
      continue;
    }

    if (indexStatus !== " ") {
      stagedPaths.push(path);
    }

    if (worktreeStatus !== " ") {
      unstagedPaths.push(path);
    }
  }

  return {
    stagedPaths: stagedPaths.sort(),
    unstagedPaths: unstagedPaths.sort(),
    untrackedPaths: untrackedPaths.sort(),
  };
}

function expectSamePaths(actual: string[], expected: string[], label: string, failures: string[]): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();

  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((path, index) => path !== expectedSorted[index])
  ) {
    failures.push(`${label} were ${JSON.stringify(actualSorted)}, expected ${JSON.stringify(expectedSorted)}`);
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    scenarios: [],
    trials: 1,
    fakeApi: false,
    keepWorkspaces: false,
    dryRun: false,
    parallel: 1,
  };
  let trialsSpecified = false;
  let retriesSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--scenario") {
      options.scenarios.push(...parseScenarioFilter(readArgValue(args, ++index, arg)));
    } else if (arg === "--trials") {
      trialsSpecified = true;
      options.trials = parsePositiveInteger(readArgValue(args, ++index, arg), arg);
    } else if (arg === "--retries") {
      retriesSpecified = true;
      options.retries = parsePositiveInteger(readArgValue(args, ++index, arg), arg);
    } else if (arg === "--model") {
      options.model = readArgValue(args, ++index, arg);
    } else if (arg === "--config") {
      options.configPath = resolve(readArgValue(args, ++index, arg));
    } else if (arg === "--timeout") {
      options.timeoutMs = parsePositiveInteger(readArgValue(args, ++index, arg), arg);
    } else if (arg === "--output") {
      options.output = readArgValue(args, ++index, arg);
    } else if (arg === "--tool-protocol") {
      options.toolProtocol = parseToolProtocol(readArgValue(args, ++index, arg), arg);
    } else if (arg === "--parallel") {
      options.parallel = parsePositiveInteger(readArgValue(args, ++index, arg), arg);
    } else if (arg === "--fake-api") {
      options.fakeApi = true;
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (trialsSpecified && retriesSpecified) {
    throw new Error("--retries cannot be combined with --trials.");
  }

  return options;
}

function parseToolProtocol(value: string, option: string): NonNullable<CliOptions["toolProtocol"]> {
  if (value === "auto" || value === "native" || value === "text-json" || value === "text-xml") {
    return value;
  }

  throw new Error(`${option} must be one of: auto, native, text-json, text-xml.`);
}

function parseScenarioFilter(value: string): string[] {
  return value
    .split(",")
    .map((scenario) => scenario.trim())
    .filter(Boolean);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));

  return results;
}

function readArgValue(args: string[], index: number, option: string): string {
  const value = args[index];

  if (!value) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }

  return parsed;
}

function formatSummary(results: TrialResult[]): string {
  return [
    "# Topchester Smoke Report",
    "",
    formatConsoleSummary(results),
    "",
    ...results.flatMap((result) => [
      `## ${result.scenarioId} trial ${result.trial}`,
      "",
      `status: ${result.status}`,
      `duration_ms: ${result.durationMs}`,
      ...(result.maxRetries === undefined
        ? []
        : [
            `attempts_used: ${result.attemptsUsed}`,
            `retries_used: ${result.retriesUsed}`,
            `max_retries: ${result.maxRetries}`,
          ]),
      `tool_protocol: ${result.toolProtocol ?? "none"}`,
      `tool_calls: native=${result.nativeToolCallCount}, text_json=${result.textJsonToolCallCount}, text_xml=${result.textXmlToolCallCount}`,
      formatUsageCounts(result),
      `task_plan_updates: ${result.taskPlanUpdateCount}`,
      `last_task_plan_status: ${result.lastTaskPlanStatus ?? "none"}`,
      ...(result.lastTaskPlanActiveItem ? [`last_task_plan_active_item: ${result.lastTaskPlanActiveItem}`] : []),
      `provider_rejected_tools: ${result.providerRejectedTools}`,
      ...(result.fallbackReason ? [`fallback_reason: ${result.fallbackReason}`] : []),
      `workspace: ${result.workspace}`,
      `artifacts: ${result.outputDir}`,
      "",
      ...(result.failures.length === 0 ? ["No failures."] : result.failures.map((failure) => `- ${failure}`)),
      ...(result.attempts ? ["", "Attempts:", "", ...formatAttemptSummaries(result.attempts)] : []),
      "",
    ]),
  ].join("\n");
}

function formatAttemptSummaries(attempts: TrialAttemptSummary[]): string[] {
  return attempts.flatMap((attempt) => [
    `- attempt ${attempt.attempt}: ${attempt.status}, duration_ms: ${attempt.durationMs}, ${formatUsageCounts(attempt)}, artifacts: ${attempt.outputDir}`,
    ...attempt.failures.map((failure) => `  - ${failure}`),
  ]);
}

function formatConsoleSummary(results: TrialResult[]): string {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  const tokens = sumTokenCounts(results);

  return [`passed: ${passed}, failed: ${failed}, total: ${results.length}`, formatUsageCounts(tokens)].join("\n");
}

function formatUsageCounts(counts: {
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
}): string {
  return [
    `tokens: input=${formatTokenCount(counts.inputTokenCount)}`,
    `output=${formatTokenCount(counts.outputTokenCount)}`,
    `total=${formatTokenCount(counts.totalTokenCount)}`,
    ...(counts.costUsd === undefined ? [] : [`cost=${formatCostUsd(counts.costUsd)}`]),
  ].join(" ");
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCostUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function sumTokenCounts(results: TrialResult[]): {
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
} {
  let costUsd: number | undefined;
  const tokens = results.reduce(
    (total, result) => {
      if (result.costUsd !== undefined) {
        costUsd = (costUsd ?? 0) + result.costUsd;
      }

      return {
        inputTokenCount: total.inputTokenCount + result.inputTokenCount,
        outputTokenCount: total.outputTokenCount + result.outputTokenCount,
        totalTokenCount: total.totalTokenCount + result.totalTokenCount,
      };
    },
    { inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0 }
  );

  return {
    ...tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function sumModelResponseTokens(modelResponses: Array<Record<string, unknown>>): {
  inputTokenCount: number;
  outputTokenCount: number;
  totalTokenCount: number;
  costUsd?: number;
} {
  let costUsd: number | undefined;
  const tokens = modelResponses.reduce(
    (total, event) => {
      const eventCostUsd = readCostUsd(event.costUsd);

      if (eventCostUsd !== undefined) {
        costUsd = (costUsd ?? 0) + eventCostUsd;
      }

      return {
        inputTokenCount: total.inputTokenCount + readTokenCount(event.inputTokens),
        outputTokenCount: total.outputTokenCount + readTokenCount(event.outputTokens),
        totalTokenCount: total.totalTokenCount + readTokenCount(event.totalTokens),
      };
    },
    { inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0 }
  );

  return {
    ...tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function readTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readCostUsd(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTrialLine(result: TrialResult): string {
  const marker = result.status === "passed" ? "✓" : "×";
  const duration = `${Math.max(1, Math.round(result.durationMs))}ms`;
  const summary =
    result.status === "passed" ? "passed" : result.failures[0] === undefined ? "failed" : result.failures[0];
  const retries = result.maxRetries === undefined ? "" : `retries ${result.retriesUsed}/${result.maxRetries}`;
  const protocol = result.toolProtocol ?? "no-tools";
  const parts = [
    marker,
    result.scenarioId,
    `trial ${result.trial}`,
    summary,
    ...(retries ? [retries] : []),
    `[${protocol}]`,
    `(${duration})`,
  ];

  return gray(parts.join("\t"));
}

async function readProtocolMetadata(outputDir: string): Promise<ProtocolMetadata> {
  const logEvents = await readJsonLines<Record<string, unknown>>(join(outputDir, "topchester.log"));
  const modelResponses = logEvents.filter((event) => event.event === "model_response");
  const sources = modelResponses
    .map((event) => event.toolCallSource)
    .filter((source): source is string => typeof source === "string");
  const fallbackReason = modelResponses
    .map((event) => event.fallbackReason)
    .find((reason): reason is string => typeof reason === "string" && reason.length > 0);
  const lastToolProtocol = modelResponses
    .filter((event) => typeof event.toolCallSource === "string")
    .map((event) => event.toolProtocol)
    .filter((protocol): protocol is string => typeof protocol === "string")
    .at(-1);
  const lastResponseProtocol = modelResponses
    .map((event) => event.toolProtocol)
    .filter((protocol): protocol is string => typeof protocol === "string")
    .at(-1);
  const tokens = sumModelResponseTokens(modelResponses);
  const taskPlanEvents = await readTaskPlanJsonEvents(outputDir);
  const lastTaskPlan = taskPlanEvents.at(-1);
  const lastTaskPlanActiveItem = lastTaskPlan?.items.find((item) => item.status === "in_progress")?.text;

  return {
    toolProtocol: lastToolProtocol ?? lastResponseProtocol,
    nativeToolCallCount: sources.filter((source) => source === "native").length,
    textJsonToolCallCount: sources.filter((source) => source === "text-json").length,
    textXmlToolCallCount: sources.filter((source) => source === "text-xml").length,
    providerRejectedTools: modelResponses.some((event) => event.providerRejectedTools === true),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...tokens,
    taskPlanUpdateCount: taskPlanEvents.length,
    ...(lastTaskPlan ? { lastTaskPlanStatus: summarizeTaskPlanStatus(lastTaskPlan.items) } : {}),
    ...(lastTaskPlanActiveItem ? { lastTaskPlanActiveItem } : {}),
  };
}

async function readTaskPlanJsonEvents(outputDir: string): Promise<Array<{ items: TaskPlanJsonItem[] }>> {
  const eventFiles = (await readdir(outputDir))
    .filter((entry) => /^events-\d+\.jsonl$/u.test(entry))
    .sort((left, right) => left.localeCompare(right));
  const events = (await Promise.all(eventFiles.map((entry) => readJsonLines<JsonLine>(join(outputDir, entry))))).flat();

  return events
    .map((event) => event.event?.plan)
    .filter((plan): plan is { items: TaskPlanJsonItem[] } => {
      return Boolean(plan) && Array.isArray(plan.items) && plan.items.every(isTaskPlanJsonItem);
    });
}

interface TaskPlanJsonItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

function isTaskPlanJsonItem(value: unknown): value is TaskPlanJsonItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as { text?: unknown; status?: unknown };

  return (
    typeof item.text === "string" &&
    (item.status === "pending" || item.status === "in_progress" || item.status === "completed")
  );
}

function summarizeTaskPlanStatus(items: TaskPlanJsonItem[]): "empty" | "completed" | "in_progress" | "pending" {
  if (items.length === 0) {
    return "empty";
  }

  if (items.every((item) => item.status === "completed")) {
    return "completed";
  }

  if (items.some((item) => item.status === "in_progress")) {
    return "in_progress";
  }

  return "pending";
}

function gray(text: string): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) {
    return text;
  }

  return `\u001b[90m${text}\u001b[0m`;
}

function isExecError(error: unknown): error is Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
} {
  return error instanceof Error && ("stdout" in error || "stderr" in error || "code" in error);
}
