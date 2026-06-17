import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadedTask } from "./task-loader.ts";
import type { AssertionResult, TaskVerifier, VerifierContext, VerifierResult } from "./types.ts";

export const hiddenVerifierSentinel = "TOPCHESTER_MINI_BENCH_HIDDEN_VERIFIER_SENTINEL_v1";

export async function runHiddenVerifier(input: {
  task: LoadedTask;
  workspacePath: string;
  runPath: string;
}): Promise<VerifierResult> {
  const boundaryAssertion = await assertHiddenVerifierBoundary(input.workspacePath);
  if (!boundaryAssertion.passed) {
    return {
      passed: false,
      score: 0,
      assertions: [boundaryAssertion],
    };
  }

  const verifierPath = resolve(input.task.taskPath, "verifier", "verify.ts");
  const imported = (await import(`${pathToFileURL(verifierPath).href}?cacheBust=${Date.now()}`)) as {
    default?: TaskVerifier;
    verify?: TaskVerifier;
  };
  const verifier = imported.default ?? imported.verify;

  if (!verifier) {
    throw new Error(`Verifier ${verifierPath} must export default verifier function or named verify function`);
  }

  const context: VerifierContext = {
    taskId: input.task.definition.id,
    workspacePath: input.workspacePath,
    taskPath: input.task.taskPath,
    runPath: input.runPath,
  };
  const result = await verifier(context);

  return normalizeVerifierResult({
    ...result,
    assertions: [boundaryAssertion, ...result.assertions],
  });
}

function normalizeVerifierResult(result: VerifierResult): VerifierResult {
  const assertions = result.assertions ?? [];
  const passed = assertions.length > 0 ? assertions.every((assertion) => assertion.passed) : Boolean(result.passed);

  return {
    passed,
    score: passed ? Math.max(1, result.score) : Math.min(result.score, 0),
    assertions,
  };
}

async function assertHiddenVerifierBoundary(workspacePath: string): Promise<AssertionResult> {
  const leakedFiles: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }

      const path = resolve(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const content = await readFile(path, "utf8").catch(() => "");
      if (content.includes(hiddenVerifierSentinel)) {
        leakedFiles.push(path);
      }
    }
  }

  await walk(workspacePath);

  return {
    name: "hidden verifier files are not visible in workspace",
    passed: leakedFiles.length === 0,
    message:
      leakedFiles.length === 0
        ? "Hidden verifier sentinel was absent from the agent-visible workspace."
        : `Hidden verifier sentinel leaked into workspace files: ${leakedFiles.join(", ")}`,
  };
}
