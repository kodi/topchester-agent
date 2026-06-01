import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";

interface FakeApiHandle {
  baseURL: string;
  close(): Promise<void>;
  requests: FakeApiRequest[];
}

interface FakeApiRequest {
  model: string;
  prompt: string;
}

export async function startFakeApi(): Promise<FakeApiHandle> {
  const requests: FakeApiRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    try {
      const body = (await readJson(request)) as { model?: unknown; messages?: unknown; tools?: unknown };
      const model = typeof body.model === "string" ? body.model : "unknown";
      const prompt = extractPrompt(body.messages);
      const content = chooseResponse(prompt);
      requests.push({ model, prompt });
      writeJson(response, 200, {
        id: `fake-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            ...formatFakeChoice(model, body.tools, content),
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      });
    } catch (error) {
      writeJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake API did not bind to a TCP port.");
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => closeServer(server, sockets),
  };
}

function formatFakeChoice(model: string, tools: unknown, content: string): Record<string, unknown> {
  const toolCall = model.includes("native") && Array.isArray(tools) ? parseFakeToolCall(content) : undefined;

  if (!toolCall) {
    return {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content,
      },
    };
  }

  return {
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `fake-call-${toolCall.tool}`,
          type: "function",
          function: {
            name: toolCall.tool,
            arguments: JSON.stringify(toolCall.args),
          },
        },
      ],
    },
  };
}

function parseFakeToolCall(content: string): { tool: string; args: Record<string, unknown> } | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { tool?: unknown }).tool === "string" &&
      typeof (parsed as { args?: unknown }).args === "object" &&
      (parsed as { args?: unknown }).args !== null
    ) {
      return {
        tool: (parsed as { tool: string }).tool,
        args: (parsed as { args: Record<string, unknown> }).args,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function chooseResponse(prompt: string): string {
  if (prompt.includes("Create an L1 file entry for this workspace-relative path.")) {
    return JSON.stringify({
      language: "typescript",
      summary: "Exports a smoke-test value.",
      responsibilities: ["Provide a small value for smoke tests."],
      symbols: [],
      imports: [],
      exports: ["value"],
      module_ids: [],
      feature_ids: [],
      test_ids: [],
      evidence: [{ kind: "path", value: "src/value.ts" }],
      confidence: "medium",
    });
  }

  if (prompt.includes("PLAN_TODO_SMOKE") && prompt.includes("Tool result from edit_file")) {
    if (prompt.includes("completed: 2")) {
      return "Updated notes.txt with a visible plan.";
    }

    return toolCall("plan_todo", {
      items: [
        { text: "Inspect notes file", status: "completed" },
        { text: "Update notes file", status: "completed" },
      ],
    });
  }

  if (prompt.includes("PLAN_TODO_SMOKE") && prompt.includes("Tool result from read_file")) {
    if (prompt.includes("completed: 1")) {
      return toolCall("edit_file", {
        path: "notes.txt",
        edits: [{ old_text: "plan status: pending\n", new_text: "plan status: visible\n" }],
      });
    }

    return toolCall("plan_todo", {
      items: [
        { text: "Inspect notes file", status: "completed" },
        { text: "Update notes file", status: "in_progress" },
      ],
    });
  }

  if (prompt.includes("PLAN_TODO_SMOKE") && prompt.includes("Tool result from plan_todo")) {
    return toolCall("read_file", { path: "notes.txt" });
  }

  if (prompt.includes("PLAN_TODO_SMOKE")) {
    return toolCall("plan_todo", {
      items: [
        { text: "Inspect notes file", status: "in_progress" },
        { text: "Update notes file", status: "pending" },
      ],
    });
  }

  if (prompt.includes("TASK_SUBAGENT_SMOKE") && prompt.includes("Tool result from task")) {
    return "Subagent found marker aqua.";
  }

  if (prompt.includes("TASK_SUBAGENT_SMOKE")) {
    return toolCall("task", {
      description: "Inspect task subagent smoke marker",
      prompt: "TASK_SUBAGENT_CHILD read docs/task-subagent-note.txt and report the exact marker line from that file.",
      subagent_type: "explore",
    });
  }

  if (prompt.includes("TASK_SUBAGENT_CHILD") && prompt.includes("Tool result from read_file")) {
    return "Child result: subagent marker: aqua";
  }

  if (prompt.includes("TASK_SUBAGENT_CHILD")) {
    return toolCall("read_file", { path: "docs/task-subagent-note.txt" });
  }

  if (prompt.includes("RUN_VALIDATOR_SMOKE") && prompt.includes("Tool result from run_validator")) {
    return "Validator smoke passed: RUN_VALIDATOR_SMOKE passed";
  }

  if (prompt.includes("RUN_VALIDATOR_SMOKE")) {
    return toolCall("run_validator", {
      command: "pnpm test",
      validator: "test",
      workdir: ".",
      timeout_ms: 15000,
    });
  }

  if (prompt.includes("BASH_SMOKE") && prompt.includes("Tool result from bash")) {
    return "BASH_SMOKE shell ok\nBASH_SMOKE passed";
  }

  if (prompt.includes("BASH_SMOKE")) {
    if (prompt.includes("run_command:")) {
      return "RUN_COMMAND_VISIBLE";
    }

    return toolCall("bash", {
      command: "echo BASH_SMOKE shell ok && echo BASH_SMOKE passed",
      workdir: ".",
      timeout_ms: 15000,
      description: "print bash smoke marker",
    });
  }

  if (
    prompt.includes("PROJECT_INSTRUCTIONS_NESTED_EDIT_SMOKE") &&
    prompt.includes("Tool result from edit_file") &&
    prompt.includes("+marker=nested-ok")
  ) {
    return "Nested project instructions were applied.";
  }

  if (
    prompt.includes("PROJECT_INSTRUCTIONS_NESTED_EDIT_SMOKE") &&
    prompt.includes("Tool result from edit_file") &&
    prompt.includes("did not change src/value.txt")
  ) {
    return toolCall("edit_file", {
      path: "src/value.txt",
      edits: [{ old_text: "marker=old\n", new_text: "marker=nested-ok\n" }],
    });
  }

  if (prompt.includes("PROJECT_INSTRUCTIONS_NESTED_EDIT_SMOKE")) {
    return toolCall("edit_file", {
      path: "src/value.txt",
      edits: [{ old_text: "marker=old\n", new_text: "marker=nested-ok\n" }],
    });
  }

  if (
    prompt.includes("PROJECT_INSTRUCTIONS_ROOT_SMOKE") &&
    prompt.includes("ROOT_INSTRUCTION_EXPECTED: root instruction applied")
  ) {
    return "root instruction applied";
  }

  if (prompt.includes("Tool result from edit_file")) {
    return "Done.";
  }

  if (prompt.includes("Tool result from write_file")) {
    return "Created test/generated-smoke.test.ts.";
  }

  if (prompt.includes("WRITE_FILE_SMOKE")) {
    return toolCall("write_file", {
      path: "test/generated-smoke.test.ts",
      content:
        'import { expect, it } from "vitest";\n\nit("WRITE_FILE_SMOKE", () => {\n  expect(true).toBe(true);\n});\n',
      create_parent_dirs: true,
    });
  }

  if (prompt.includes("Read data.txt") && prompt.includes("Tool result from read_file")) {
    return toolCall("edit_file", {
      path: "summary.txt",
      edits: [{ old_text: "TODO\n", new_text: "This file contains user account notes.\n" }],
    });
  }

  if (prompt.includes("Read data.txt")) {
    return toolCall("read_file", { path: "data.txt" });
  }

  if (prompt.includes("runtime notes") && prompt.includes("Tool result from read_file")) {
    return "The configured port is 4173.";
  }

  if (prompt.includes("runtime notes") && prompt.includes("Tool result from find_file")) {
    return toolCall("read_file", { path: "docs/runtime-notes.txt" });
  }

  if (prompt.includes("runtime notes")) {
    return toolCall("find_file", { query: "runtime notes", path: ".", limit: 20 });
  }

  if (prompt.includes("FEATURE_FLAG") && prompt.includes("Tool result from grep")) {
    return "FEATURE_FLAG is defined in src/flags.ts.";
  }

  if (prompt.includes("FEATURE_FLAG")) {
    return toolCall("grep", { pattern: "FEATURE_FLAG", path: "." });
  }

  if (prompt.includes("change Hello to Goodbye") && prompt.includes("Tool result from read_file")) {
    return toolCall("edit_file", {
      path: "greeting.txt",
      edits: [{ old_text: "Hello\n", new_text: "Goodbye\n" }],
    });
  }

  if (prompt.includes("change Hello to Goodbye")) {
    return toolCall("read_file", { path: "greeting.txt" });
  }

  if (prompt.includes("set debug to true and retries to 3") && prompt.includes("Tool result from read_file")) {
    return toolCall("edit_file", {
      path: "config.txt",
      edits: [
        { old_text: "debug=false\n", new_text: "debug=true\n" },
        { old_text: "retries=1\n", new_text: "retries=3\n" },
      ],
    });
  }

  if (prompt.includes("set debug to true and retries to 3")) {
    return toolCall("read_file", { path: "config.txt" });
  }

  if (prompt.includes("top-level docs files") && prompt.includes("Tool result from inspect_command")) {
    return "The docs files include docs/guide.md and docs/notes.md.";
  }

  if (prompt.includes("top-level docs files")) {
    return toolCall("inspect_command", {
      command: "pwd && rg --files docs | head -20",
      workdir: ".",
      timeout_ms: 10000,
    });
  }

  if (prompt.includes("Stage and commit only commit-me.txt") && prompt.includes("Tool result from git_commit")) {
    return "Committed commit-me.txt and left the unrelated changes outside the commit.";
  }

  if (prompt.includes("Stage and commit only commit-me.txt") && prompt.includes("Tool result from git_add")) {
    return toolCall("git_commit", {
      message: "Commit selected smoke file",
      expected_staged_paths: ["commit-me.txt"],
    });
  }

  if (prompt.includes("Stage and commit only commit-me.txt") && prompt.includes("Tool result from git_status")) {
    return toolCall("git_add", {
      paths: ["commit-me.txt"],
      expected_status: [{ path: "commit-me.txt", status: "modified" }],
    });
  }

  if (prompt.includes("Stage and commit only commit-me.txt")) {
    return toolCall("git_status", { path: ".", include_untracked: true });
  }

  if (prompt.includes("Stage only tracked-change.txt") && prompt.includes("Tool result from git_status")) {
    return toolCall("git_add", {
      paths: ["tracked-change.txt"],
      expected_status: [{ path: "tracked-change.txt", status: "modified" }],
    });
  }

  if (prompt.includes("Stage only tracked-change.txt")) {
    return toolCall("git_status", { path: ".", include_untracked: true });
  }

  if (prompt.includes("current git status") && prompt.includes("Tool result from git_diff")) {
    return "The repo has staged, unstaged, and untracked Git changes.";
  }

  if (prompt.includes("current git status") && prompt.includes("Tool result from git_status")) {
    return toolCall("git_diff", { scope: "all", include_untracked: true });
  }

  if (prompt.includes("current git status")) {
    return toolCall("git_status", { path: ".", include_untracked: true });
  }

  if (prompt.includes("value is 2") && prompt.includes("Tool result from read_file")) {
    return toolCall("edit_file", {
      path: "src/value.ts",
      edits: [{ old_text: "export const value = 1;\n", new_text: "export const value = 2;\n" }],
    });
  }

  if (prompt.includes("value is 2")) {
    return toolCall("read_file", { path: "src/value.ts" });
  }

  if (prompt.includes("Remember that this scenario code is alpha-seven")) {
    return "I will remember alpha-seven.";
  }

  if (prompt.includes("What scenario code did I give you")) {
    return "You gave me alpha-seven.";
  }

  if (prompt.includes("What should I do before using project knowledge here")) {
    return "Run /kb init, then /kb sync.";
  }

  return "Done.";
}

function toolCall(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ tool, args });
}

function extractPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return "";
      }

      const content = (message as { content?: unknown }).content;

      if (typeof content === "string") {
        return content;
      }

      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (!part || typeof part !== "object") {
              return "";
            }

            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          })
          .join("\n");
      }

      return "";
    })
    .join("\n");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  server.unref();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  for (const socket of sockets) {
    socket.destroy();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, 1000);
    timeout.unref?.();

    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
