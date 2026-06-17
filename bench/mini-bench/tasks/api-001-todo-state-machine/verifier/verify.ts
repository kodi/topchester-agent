import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Express } from "express";
import type { AssertionResult, TaskVerifier } from "../../../src/types.ts";

interface TodoApiModule {
  createApp?: () => Express;
}

interface HttpResult {
  status: number;
  body: any;
}

const verify: TaskVerifier = async (context) => {
  const modulePath = resolve(context.workspacePath, "src", "app.ts");
  const imported = (await import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`)) as TodoApiModule;
  const assertions: AssertionResult[] = [];

  assertions.push({
    name: "exports createApp function",
    passed: typeof imported.createApp === "function",
    message: "src/app.ts must export createApp().",
  });

  if (typeof imported.createApp !== "function") {
    return { passed: false, score: 0, assertions };
  }

  await runCase(assertions, "creates todos, normalizes fields, and lists with filters", async () => {
    await withServer(imported.createApp!, async (request) => {
      const first = await request("POST", "/todos", {
        title: "  Ship API  ",
        assignee: " Ada ",
      });
      assert.equal(first.status, 201);
      assertTodo(first.body, {
        title: "Ship API",
        status: "todo",
        assignee: "Ada",
      });

      const second = await request("POST", "/todos", {
        title: "Review metrics",
        assignee: " Grace ",
      });
      assert.equal(second.status, 201);
      assertTodo(second.body, {
        title: "Review metrics",
        status: "todo",
        assignee: "Grace",
      });

      const unassigned = await request("POST", "/todos", {
        title: "Clean backlog",
        assignee: "   ",
      });
      assert.equal(unassigned.status, 201);
      assert.equal(unassigned.body.assignee, null);

      const all = await request("GET", "/todos");
      assert.equal(all.status, 200);
      assert.deepEqual(
        all.body.map((todo: any) => todo.title),
        ["Ship API", "Review metrics", "Clean backlog"]
      );

      const filtered = await request("GET", "/todos?status=todo&assignee=Ada");
      assert.equal(filtered.status, 200);
      assert.deepEqual(
        filtered.body.map((todo: any) => todo.id),
        [first.body.id]
      );
    });
  });

  await runCase(assertions, "enforces state transitions and preserves state on rejected transitions", async () => {
    await withServer(imported.createApp!, async (request) => {
      const created = await request("POST", "/todos", {
        title: "Investigate timeout",
      });
      assert.equal(created.status, 201);

      const invalidEarlyArchive = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "done",
      });
      assert.equal(invalidEarlyArchive.status, 409);
      assert.equal(invalidEarlyArchive.body.error.code, "invalid_transition");

      const afterRejected = await request("GET", `/todos/${created.body.id}`);
      assert.equal(afterRejected.status, 200);
      assert.equal(afterRejected.body.status, "todo");

      const doing = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "doing",
      });
      assert.equal(doing.status, 200);
      assert.equal(doing.body.status, "doing");

      const blocked = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "blocked",
      });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.body.status, "blocked");

      const invalidDoneFromBlocked = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "done",
      });
      assert.equal(invalidDoneFromBlocked.status, 409);

      const backToDoing = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "doing",
      });
      assert.equal(backToDoing.status, 200);

      const done = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "done",
      });
      assert.equal(done.status, 200);

      const archived = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "archived",
      });
      assert.equal(archived.status, 200);
      assert.equal(archived.body.status, "archived");

      const reopen = await request("PATCH", `/todos/${created.body.id}/status`, {
        status: "todo",
      });
      assert.equal(reopen.status, 409);
      const final = await request("GET", `/todos/${created.body.id}`);
      assert.equal(final.body.status, "archived");
    });
  });

  await runCase(assertions, "returns structured client errors and isolates app instances", async () => {
    await withServer(imported.createApp!, async (request) => {
      const badTitle = await request("POST", "/todos", { title: "   " });
      assert.equal(badTitle.status, 400);
      assert.equal(badTitle.body.error.code, "invalid_title");

      const unknownStatus = await request("GET", "/todos?status=waiting");
      assert.equal(unknownStatus.status, 400);
      assert.equal(unknownStatus.body.error.code, "invalid_status");

      const missing = await request("GET", "/todos/does-not-exist");
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "not_found");

      const created = await request("POST", "/todos", { title: "Instance one" });
      assert.equal(created.status, 201);
    });

    await withServer(imported.createApp!, async (request) => {
      const all = await request("GET", "/todos");
      assert.equal(all.status, 200);
      assert.deepEqual(all.body, []);
    });
  });

  const passed = assertions.every((assertion) => assertion.passed);
  return {
    passed,
    score: passed ? 1 : 0,
    assertions,
  };
};

async function runCase(assertions: AssertionResult[], name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
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

async function withServer(
  createApp: () => Express,
  fn: (request: (method: string, path: string, body?: unknown) => Promise<HttpResult>) => Promise<void>
): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind verifier server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(async (method, path, body) => {
      const options: RequestInit = {
        method,
      };
      if (body !== undefined) {
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(body);
      }

      const response = await fetch(`${baseUrl}${path}`, options);
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : undefined,
      };
    });
  } finally {
    await closeServer(server);
  }
}

function assertTodo(value: any, expected: { title: string; status: string; assignee: string | null }): void {
  assert.equal(typeof value.id, "string");
  assert.ok(value.id.length > 0);
  assert.equal(value.title, expected.title);
  assert.equal(value.status, expected.status);
  assert.equal(value.assignee, expected.assignee);
  assert.ok(!Number.isNaN(Date.parse(value.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(value.updatedAt)));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

export default verify;
