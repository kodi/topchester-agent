export type MiniBenchCommand = "list" | "run" | "verify-fixtures" | "up" | "down" | "clean" | "help";

export type TaskCategory = "typescript" | "api" | "database" | "agent";

export interface TaskDefinition {
  id: string;
  name: string;
  category: TaskCategory;
  difficulty: string;
  prompt: string;
  workspace: string;
  bootstrap?: {
    script?: string | null;
  };
  services?: string[];
  verifier: {
    command: string;
  };
  timeoutMs: number;
  agent?: {
    cwd?: string;
    profile?: string;
  };
  expected?: {
    changedFiles?: string[];
  };
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  message?: string;
}

export interface VerifierResult {
  passed: boolean;
  score: number;
  assertions: AssertionResult[];
}

export interface VerifierContext {
  taskId: string;
  workspacePath: string;
  taskPath: string;
  runPath: string;
}

export type TaskVerifier = (context: VerifierContext) => Promise<VerifierResult> | VerifierResult;

export interface RunOptions {
  taskId?: string;
  taskIds?: string[];
  noAgent: boolean;
  candidate?: string;
  model?: string;
  config?: string;
  timeoutMs?: number;
  keepRuns: boolean;
  output?: string;
}

export interface RunReport {
  runId: string;
  taskId: string;
  taskName: string;
  status: "passed" | "failed" | "agent_timeout";
  mode: "candidate" | "agent";
  candidate?: string;
  model?: string;
  config?: string;
  workspacePath: string;
  runPath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  verifier: VerifierResult;
  agent?: {
    exitCode: number | null;
    timedOut: boolean;
    stdoutPath: string;
    stderrPath: string;
    eventsPath: string;
    eventsSourcePath?: string;
    topchesterArtifactsPath?: string;
    sessionEventPaths: string[];
    debugLogPath?: string;
    stdoutTail: string;
    stderrTail: string;
    toolCalls: Record<string, number>;
    eventCount: number;
    eventKinds: Record<string, number>;
    messageRoles: Record<string, number>;
    taskPlanCount: number;
    todoUpdateCount: number;
    statusCount: number;
  };
}
