import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AssertionResult, TaskVerifier, UserSummaryForTask000 } from "../../../src/verifiers/task-000-types.ts";

const hiddenCases = [
  {
    name: "handles duplicates, casing, blanks, and inactive users",
    users: [
      { name: "Ada", email: "ada@Example.com", role: "admin", active: true },
      { name: " Ada ", email: "ada@EXAMPLE.com", role: "admin", active: true },
      { name: "bob", email: "bob@Tools.dev", role: "member", active: true },
      { name: "Carol", email: "carol@Example.COM", role: "guest", active: false },
      { name: "", email: "empty@none.test", role: "guest", active: true },
    ],
    expected: {
      totalActive: 3,
      names: ["Ada", "bob"],
      domains: ["example.com", "tools.dev"],
      countByRole: {
        admin: 2,
        member: 1,
        guest: 0,
      },
    },
  },
  {
    name: "handles empty input",
    users: [],
    expected: {
      totalActive: 0,
      names: [],
      domains: [],
      countByRole: {
        admin: 0,
        member: 0,
        guest: 0,
      },
    },
  },
] as const;

const verify: TaskVerifier = async (context) => {
  const modulePath = resolve(context.workspacePath, "src", "summary.ts");
  const imported = (await import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`)) as {
    summarizeUsers?: (users: unknown[]) => UserSummaryForTask000;
  };
  const assertions: AssertionResult[] = [];

  assertions.push({
    name: "exports summarizeUsers function",
    passed: typeof imported.summarizeUsers === "function",
    message:
      typeof imported.summarizeUsers === "function"
        ? "summarizeUsers is exported."
        : "src/summary.ts must export summarizeUsers(users).",
  });

  if (typeof imported.summarizeUsers !== "function") {
    return { passed: false, score: 0, assertions };
  }

  for (const testCase of hiddenCases) {
    try {
      assert.deepEqual(imported.summarizeUsers([...testCase.users]), testCase.expected);
      assertions.push({
        name: testCase.name,
        passed: true,
        message: "Behavior matched hidden case.",
      });
    } catch {
      assertions.push({
        name: testCase.name,
        passed: false,
        message: "Behavior did not match the hidden case.",
      });
    }
  }

  const passed = assertions.every((assertion) => assertion.passed);
  return {
    passed,
    score: passed ? 1 : 0,
    assertions,
  };
};

export default verify;
