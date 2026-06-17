import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "./app.ts";

const serverContext = await startServer();
const baseUrl = serverContext.baseUrl;

try {
  const created = await request("POST", "/todos", {
    title: " Write docs ",
    assignee: " Ada ",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, "Write docs");
  assert.equal(created.body.assignee, "Ada");
  assert.equal(created.body.status, "todo");
  assert.equal(typeof created.body.id, "string");

  const transitioned = await request("PATCH", `/todos/${created.body.id}/status`, {
    status: "doing",
  });
  assert.equal(transitioned.status, 200);
  assert.equal(transitioned.body.status, "doing");

  const invalidTransition = await request("PATCH", `/todos/${created.body.id}/status`, {
    status: "archived",
  });
  assert.equal(invalidTransition.status, 409);
  assert.equal(invalidTransition.body.error.code, "invalid_transition");

  const fetched = await request("GET", `/todos/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.status, "doing");

  const filtered = await request("GET", "/todos?status=doing&assignee=Ada");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].id, created.body.id);

  const badCreate = await request("POST", "/todos", { title: "   " });
  assert.equal(badCreate.status, 400);
  assert.equal(badCreate.body.error.code, "invalid_title");

  console.log("todo api tests passed");
} finally {
  await serverContext.close();
}

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
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
}
