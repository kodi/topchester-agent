import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssertionResult, TaskVerifier } from "../../../src/types.ts";

const verify: TaskVerifier = async (context) => {
  const modulePath = resolve(context.workspacePath, "src", "migrate.ts");
  const imported = (await import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`)) as {
    migrateConfigs?: (records: unknown[]) => unknown;
  };
  const assertions: AssertionResult[] = [];

  assertions.push({
    name: "exports migrateConfigs function",
    passed: typeof imported.migrateConfigs === "function",
    message:
      typeof imported.migrateConfigs === "function"
        ? "migrateConfigs is exported."
        : "src/migrate.ts must export migrateConfigs(records).",
  });

  if (typeof imported.migrateConfigs !== "function") {
    return { passed: false, score: 0, assertions };
  }

  runCase(assertions, "migrates mixed valid records and preserves unknown fields", () => {
    const result = imported.migrateConfigs?.([
      {
        id: "alpha",
        settings: {
          retries: "0",
          timeoutMs: "100",
          tags: [" Ops ", "ops", "Backend"],
        },
        metadata: {
          team: "infra",
          priority: 2,
        },
        rollout: {
          percent: 25,
        },
        notes: null,
      },
      {
        id: "beta",
        enabled: true,
        settings: {
          retries: 10,
          timeoutMs: 60000,
          tags: "Beta, EDGE, beta,,edge",
        },
        metadata: {},
      },
    ]);

    assert.deepEqual(normalizeErrorMessages(result), {
      configs: [
        {
          version: 2,
          id: "alpha",
          enabled: true,
          retry: {
            maxAttempts: 0,
            timeoutMs: 100,
          },
          tags: ["backend", "ops"],
          metadata: {
            team: "infra",
            priority: 2,
          },
          extras: {
            rollout: {
              percent: 25,
            },
            notes: null,
          },
        },
        {
          version: 2,
          id: "beta",
          enabled: true,
          retry: {
            maxAttempts: 10,
            timeoutMs: 60000,
          },
          tags: ["beta", "edge"],
          metadata: {},
          extras: {},
        },
      ],
      errors: [],
    });
  });

  runCase(assertions, "skips invalid records with stable error indexes", () => {
    const result = imported.migrateConfigs?.([
      null,
      {
        id: "bad-enabled",
        enabled: "yes",
      },
      {
        id: "bad-retry",
        settings: {
          retries: 11,
        },
      },
      {
        id: "bad-timeout",
        settings: {
          timeoutMs: 99,
        },
      },
      {
        id: "bad-metadata",
        metadata: [],
      },
      {
        id: "valid-after-errors",
        enabled: false,
      },
    ]);

    assert.deepEqual(normalizeErrorMessages(result), {
      configs: [
        {
          version: 2,
          id: "valid-after-errors",
          enabled: false,
          retry: {
            maxAttempts: 3,
            timeoutMs: 5000,
          },
          tags: [],
          metadata: {},
          extras: {},
        },
      ],
      errors: [
        {
          index: 0,
          code: "invalid_record",
          message: "<message>",
        },
        {
          index: 1,
          id: "bad-enabled",
          code: "invalid_enabled",
          message: "<message>",
        },
        {
          index: 2,
          id: "bad-retry",
          code: "invalid_retries",
          message: "<message>",
        },
        {
          index: 3,
          id: "bad-timeout",
          code: "invalid_timeout",
          message: "<message>",
        },
        {
          index: 4,
          id: "bad-metadata",
          code: "invalid_metadata",
          message: "<message>",
        },
      ],
    });
  });

  runCase(assertions, "rejects malformed scalar settings", () => {
    const result = imported.migrateConfigs?.([
      {
        id: "float-retry",
        settings: {
          retries: 1.5,
        },
      },
      {
        id: "word-timeout",
        settings: {
          timeoutMs: "fast",
        },
      },
      {
        id: "bad-tags",
        settings: {
          tags: [42],
        },
      },
    ]);

    assert.deepEqual(normalizeErrorMessages(result), {
      configs: [],
      errors: [
        {
          index: 0,
          id: "float-retry",
          code: "invalid_retries",
          message: "<message>",
        },
        {
          index: 1,
          id: "word-timeout",
          code: "invalid_timeout",
          message: "<message>",
        },
        {
          index: 2,
          id: "bad-tags",
          code: "invalid_tags",
          message: "<message>",
        },
      ],
    });
  });

  const passed = assertions.every((assertion) => assertion.passed);
  return {
    passed,
    score: passed ? 1 : 0,
    assertions,
  };
};

function runCase(assertions: AssertionResult[], name: string, fn: () => void): void {
  try {
    fn();
    assertions.push({
      name,
      passed: true,
      message: "Behavior matched hidden case.",
    });
  } catch (error) {
    assertions.push({
      name,
      passed: false,
      message: `Behavior did not match the hidden case. ${formatError(error)}`,
    });
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return "";
  }

  const compact = error.message
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 14)
    .join("\n");
  return compact.length <= 1_200 ? compact : `${compact.slice(0, 1_200)}...`;
}

function normalizeErrorMessages(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const result = value as { errors?: unknown[] };
  if (!Array.isArray(result.errors)) {
    return value;
  }

  return {
    ...result,
    errors: result.errors.map((error) => {
      if (!error || typeof error !== "object") {
        return error;
      }

      const entry = error as { message?: unknown };
      return {
        ...entry,
        message: typeof entry.message === "string" && entry.message.trim() ? "<message>" : entry.message,
      };
    }),
  };
}

export default verify;
