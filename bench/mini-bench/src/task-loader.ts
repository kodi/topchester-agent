import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tasksRoot } from "./paths.ts";
import type { TaskDefinition } from "./types.ts";

export interface LoadedTask {
  definition: TaskDefinition;
  taskPath: string;
}

export async function loadTasks(): Promise<LoadedTask[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const tasks: LoadedTask[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const taskPath = resolve(tasksRoot, entry.name);
    const configPath = resolve(taskPath, "task.yaml");

    try {
      if (!(await stat(configPath)).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    tasks.push({
      definition: parseTaskDefinition(await readFile(configPath, "utf8"), configPath),
      taskPath,
    });
  }

  return tasks.sort((a, b) => a.definition.id.localeCompare(b.definition.id));
}

export async function loadTask(taskId: string): Promise<LoadedTask> {
  const tasks = await loadTasks();
  const task = tasks.find((candidate) => candidate.definition.id === taskId);

  if (!task) {
    throw new Error(`Unknown mini-bench task '${taskId}'. Run 'pnpm run list' to see available tasks.`);
  }

  return task;
}

function parseTaskDefinition(source: string, configPath: string): TaskDefinition {
  const id = requireScalar(source, configPath, "id");
  const name = requireScalar(source, configPath, "name");
  const category = requireScalar(source, configPath, "category") as TaskDefinition["category"];
  const difficulty = requireScalar(source, configPath, "difficulty");
  const prompt = requireScalar(source, configPath, "prompt");
  const workspace = requireScalar(source, configPath, "workspace");
  const verifierCommand = requireBlockScalar(source, configPath, "verifier", "command");
  const timeoutMs = Number.parseInt(requireScalar(source, configPath, "timeoutMs"), 10);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Task metadata ${configPath} is missing positive timeoutMs`);
  }

  return {
    id,
    name,
    category,
    difficulty,
    prompt,
    workspace,
    bootstrap: {
      script: readBlockScalar(source, "bootstrap", "script"),
    },
    services: [],
    verifier: {
      command: verifierCommand,
    },
    timeoutMs,
    agent: {
      cwd: readBlockScalar(source, "agent", "cwd"),
      profile: readBlockScalar(source, "agent", "profile"),
    },
    expected: {
      changedFiles: readBlockList(source, "expected", "changedFiles"),
    },
  };
}

function requireScalar(source: string, configPath: string, field: string): string {
  const value = readScalar(source, field);
  if (!value) {
    throw new Error(`Task metadata ${configPath} is missing string field '${field}'`);
  }

  return value;
}

function requireBlockScalar(source: string, configPath: string, block: string, field: string): string {
  const value = readBlockScalar(source, block, field);
  if (!value) {
    throw new Error(`Task metadata ${configPath} is missing ${block}.${field}`);
  }

  return value;
}

function readScalar(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`^${escapeRegex(field)}:\\s*(.+?)\\s*$`, "m"));
  return normalizeScalar(match?.[1]);
}

function readBlockScalar(source: string, block: string, field: string): string | undefined {
  const match = source.match(
    new RegExp(`^${escapeRegex(block)}:\\s*\\n(?:  .+\\n)*?  ${escapeRegex(field)}:\\s*(.+?)\\s*$`, "m")
  );
  return normalizeScalar(match?.[1]);
}

function readBlockList(source: string, block: string, field: string): string[] {
  const match = source.match(
    new RegExp(`^${escapeRegex(block)}:\\s*\\n(?:  .+\\n)*?  ${escapeRegex(field)}:\\s*\\n((?:    - .+\\n?)+)`, "m")
  );

  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeScalar(line.slice(2)))
    .filter((value): value is string => Boolean(value));
}

function normalizeScalar(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "null") {
    return undefined;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
