import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      writeJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    try {
      const body = (await readJson(request)) as { model?: unknown; messages?: unknown };
      const model = typeof body.model === "string" ? body.model : "unknown";
      const prompt = extractPrompt(body.messages);
      requests.push({ model, prompt });
      writeJson(response, 200, {
        id: `fake-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: chooseResponse(prompt),
            },
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
    close: () => closeServer(server),
  };
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

  if (prompt.includes("Tool result from edit_file")) {
    return "Done.";
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
    return "Run /kb init, then /kb compile.";
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
