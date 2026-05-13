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
const cliPath = join(repoRoot, "src/cli.ts");
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

const scenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.union([z.string(), z.array(z.string()).min(1)]),
  template: z.string().optional().default("template"),
  bootstrapFiles: z.array(bootstrapFileSchema).optional().default([]),
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
});

type Scenario = z.infer<typeof scenarioSchema>;

interface CliOptions {
  scenario?: string;
  trials: number;
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
  status: "passed" | "failed";
  workspace: string;
  outputDir: string;
  failures: string[];
  durationMs: number;
  toolProtocol?: string;
  nativeToolCallCount: number;
  textJsonToolCallCount: number;
  textXmlToolCallCount: number;
  providerRejectedTools: boolean;
  fallbackReason?: string;
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

  const scenarios = await loadScenarios(options.scenario);

  if (options.dryRun) {
    console.log(`loaded ${scenarios.length} smoke scenario${scenarios.length === 1 ? "" : "s"}`);
    for (const scenario of scenarios) {
      console.log(`${scenario.id}: ${scenario.name}`);
    }
    process.exitCode = 0;
    throw new DryRunComplete();
  }

  const results: TrialResult[] = [];
  const jobs = scenarios.flatMap((scenario) =>
    Array.from({ length: options.trials }, (_, index) => ({ scenario, trial: index + 1 }))
  );

  results.push(
    ...(await runWithConcurrency(jobs, Math.max(1, options.parallel), (job) =>
      runTrial(job.scenario, job.trial, options, fakeApi?.baseURL).then((result) => {
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
  options: CliOptions,
  fakeApiBaseURL: string | undefined
): Promise<TrialResult> {
  const startedAt = Date.now();
  const trialId = `${scenario.id}/trial-${trial}`;
  const outputDir = join(artifactRoot, scenario.id, `trial-${trial}`);
  const workspace = await mkdtemp(join(tmpdir(), `topchester-smoke-${scenario.id}-${trial}-`));
  const templatePath = join(scenariosRoot, scenario.id, scenario.template);
  const failures: string[] = [];
  let sessionId: string | undefined;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const runIds: string[] = [];

  await mkdir(outputDir, { recursive: true });
  await copyTemplate(templatePath, workspace);
  await applyBootstrapFiles(workspace, scenario.bootstrapFiles);

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
    status: failures.length === 0 ? "passed" : "failed",
    workspace,
    outputDir,
    failures,
    durationMs: Date.now() - startedAt,
    ...protocolMetadata,
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
    const sawDirtyEdit = logEvents.some((event) => event.event === "file_edit" && event.kbState === "needs_sync");

    if (!sawDirtyEdit) {
      failures.push("expected KB state needs_sync after edit");
    }
  }
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

async function loadScenarios(filter: string | undefined): Promise<Scenario[]> {
  const entries = await readdir(scenariosRoot, { withFileTypes: true });
  const scenarios: Scenario[] = [];

  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (filter && entry.name !== filter) {
      continue;
    }

    const configPath = join(scenariosRoot, entry.name, "config.json");
    const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const scenario = scenarioSchema.parse(raw);

    if (scenario.id !== entry.name) {
      throw new Error(`Scenario ${entry.name} config id must match folder name.`);
    }

    scenarios.push(scenario);
  }

  if (scenarios.length === 0) {
    throw new Error(filter ? `No scenario found for ${filter}.` : "No smoke scenarios found.");
  }

  return scenarios;
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

async function writeFakeApiConfig(
  outputDir: string,
  baseURL: string,
  model: string | undefined,
  toolProtocol: CliOptions["toolProtocol"]
): Promise<string> {
  const configPath = join(outputDir, "topchester-smoke.config.yaml");
  const modelId = model ?? "topchester-smoke-fake";
  await writeFile(
    configPath,
    [
      "models:",
      "  defaultPurpose: agent.primary",
      "  assignments:",
      "    agent.primary:",
      `      name: ${JSON.stringify(modelId)}`,
      "    kb.summarize:",
      `      name: ${JSON.stringify(modelId)}`,
      "    fallback:",
      `      name: ${JSON.stringify(modelId)}`,
      "  providers:",
      "    default: fake",
      "    fake:",
      "      type: openai-compatible",
      `      baseURL: ${JSON.stringify(baseURL)}`,
      "      apiKey: fake",
      ...(toolProtocol ? [`      toolProtocol: ${toolProtocol}`] : []),
    ].join("\n")
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    trials: 1,
    fakeApi: false,
    keepWorkspaces: false,
    dryRun: false,
    parallel: 1,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--scenario") {
      options.scenario = readArgValue(args, ++index, arg);
    } else if (arg === "--trials") {
      options.trials = parsePositiveInteger(readArgValue(args, ++index, arg), arg);
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

  return options;
}

function parseToolProtocol(value: string, option: string): NonNullable<CliOptions["toolProtocol"]> {
  if (value === "auto" || value === "native" || value === "text-json" || value === "text-xml") {
    return value;
  }

  throw new Error(`${option} must be one of: auto, native, text-json, text-xml.`);
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
      `tool_protocol: ${result.toolProtocol ?? "none"}`,
      `tool_calls: native=${result.nativeToolCallCount}, text_json=${result.textJsonToolCallCount}, text_xml=${result.textXmlToolCallCount}`,
      `provider_rejected_tools: ${result.providerRejectedTools}`,
      ...(result.fallbackReason ? [`fallback_reason: ${result.fallbackReason}`] : []),
      `workspace: ${result.workspace}`,
      `artifacts: ${result.outputDir}`,
      "",
      ...(result.failures.length === 0 ? ["No failures."] : result.failures.map((failure) => `- ${failure}`)),
      "",
    ]),
  ].join("\n");
}

function formatConsoleSummary(results: TrialResult[]): string {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;

  return `passed: ${passed}, failed: ${failed}, total: ${results.length}`;
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

function formatTrialLine(result: TrialResult): string {
  const marker = result.status === "passed" ? "✓" : "×";
  const duration = `${Math.max(1, Math.round(result.durationMs))}ms`;
  const summary =
    result.status === "passed" ? "passed" : result.failures[0] === undefined ? "failed" : result.failures[0];

  const protocol = result.toolProtocol ?? "no-tools";

  return gray(`${marker} ${result.scenarioId} trial ${result.trial} ${summary} [${protocol}] (${duration})`);
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

  return {
    toolProtocol: lastToolProtocol ?? lastResponseProtocol,
    nativeToolCallCount: sources.filter((source) => source === "native").length,
    textJsonToolCallCount: sources.filter((source) => source === "text-json").length,
    textXmlToolCallCount: sources.filter((source) => source === "text-xml").length,
    providerRejectedTools: modelResponses.some((event) => event.providerRejectedTools === true),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
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
