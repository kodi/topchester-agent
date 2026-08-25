import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { type AppContext } from "../src/app/context.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime/index.js";
import { executeToolCall, parseToolCall } from "../src/agent/tools.js";
import { createTopchesterLogger } from "../src/logging/index.js";

describe("logging", () => {
  it("stays silent unless a log level is configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));

    await withEnv({ TOPCHESTER_LOG_LEVEL: "", TOPCHESTER_LOG_FILE: "" }, async () => {
      const loggerInfo = createTopchesterLogger(workspace);

      loggerInfo.logger.debug({ event: "test" }, "test");

      expect(loggerInfo.level).toBe("silent");
      expect(loggerInfo.logFilePath).toBeUndefined();
    });
  });

  it("writes JSON logs to the workspace log file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: "" }, async () => {
      const loggerInfo = createTopchesterLogger(workspace);

      loggerInfo.logger.debug({ event: "test_event" }, "debug line");

      const logFilePath = loggerInfo.logFilePath;

      if (!logFilePath) {
        throw new Error("Expected logger to create a log file path.");
      }

      expect(logFilePath).toBe(join(workspace, ".agents/topchester/logs/topchester.log"));

      const lines = (await readFile(logFilePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "test_event", msg: "debug line" })])
      );
    });
  });

  it("logs edit_file metadata without debug-level edit text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));
    await writeFile(join(workspace, "example.txt"), "secret=old\n");

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: "" }, async () => {
      const loggerInfo = createTopchesterLogger(workspace);
      const call = parseToolCall(
        '{"tool":"edit_file","args":{"path":"example.txt","edits":[{"old_text":"secret=old\\n","new_text":"secret=new\\n"}]}}'
      );

      if (!call) {
        throw new Error("Expected edit_file tool call to parse.");
      }

      await executeToolCall(workspace, call, { logger: loggerInfo.logger });

      const logFilePath = loggerInfo.logFilePath;

      if (!logFilePath) {
        throw new Error("Expected logger to create a log file path.");
      }

      const logText = await readFile(logFilePath, "utf8");
      const logLines = logText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "tool_call",
            tool: "edit_file",
            args: expect.objectContaining({ path: "example.txt", editCount: 1 }),
          }),
          expect.objectContaining({
            event: "file_edit",
            path: "example.txt",
            beforeHash: expect.stringMatching(/^sha256:/),
            afterHash: expect.stringMatching(/^sha256:/),
            kbState: "needs_sync",
            diffSummary: "+1/-1",
          }),
          expect.objectContaining({
            event: "tool_result",
            tool: "edit_file",
            beforeHash: expect.stringMatching(/^sha256:/),
            afterHash: expect.stringMatching(/^sha256:/),
            kbState: "needs_sync",
          }),
        ])
      );
      expect(logText).not.toContain("secret=old");
      expect(logText).not.toContain("secret=new");
    });
  });

  it("logs write_file metadata without debug-level file content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: "" }, async () => {
      const loggerInfo = createTopchesterLogger(workspace);
      const call = parseToolCall(
        '{"tool":"write_file","args":{"path":"example.txt","content":"SECRET_CREATED_CONTENT\\n"}}'
      );

      if (!call) {
        throw new Error("Expected write_file tool call to parse.");
      }

      await executeToolCall(workspace, call, { logger: loggerInfo.logger });

      const logFilePath = loggerInfo.logFilePath;

      if (!logFilePath) {
        throw new Error("Expected logger to create a log file path.");
      }

      const logText = await readFile(logFilePath, "utf8");
      const logLines = logText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "tool_call",
            tool: "write_file",
            args: expect.objectContaining({ path: "example.txt", contentLength: 23, lineCount: 1 }),
          }),
          expect.objectContaining({
            event: "file_create",
            path: "example.txt",
            afterHash: expect.stringMatching(/^sha256:/),
            kbState: "needs_sync",
            writeSummary: "created +1",
          }),
          expect.objectContaining({
            event: "tool_result",
            tool: "write_file",
            hash: expect.stringMatching(/^sha256:/),
            bytesWritten: 23,
            lineCount: 1,
            kbState: "needs_sync",
          }),
        ])
      );
      expect(logText).not.toContain("SECRET_CREATED_CONTENT");
    });
  });

  it("logs bash metadata without debug-level command output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-logging-bin-"));
    await writeFile(join(workspace, "package.json"), "{}\n");
    await writeExecutable(join(bin, "sh"), 'eval "$2"');

    await withEnv(
      { TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: "", SECRET_VALUE: "SECRET_COMMAND_OUTPUT" },
      async () => {
        const loggerInfo = createTopchesterLogger(workspace);
        const call = parseToolCall('{"tool":"bash","args":{"command":"printf \\"$SECRET_VALUE\\""}}');

        if (!call) {
          throw new Error("Expected bash tool call to parse.");
        }

        await executeToolCall(workspace, call, {
          logger: loggerInfo.logger,
          pathEnv: bin,
          config: {
            tools: {
              bash: {
                shell: join(bin, "sh"),
                allow: ["printf"],
                allowExact: [],
                deny: [],
              },
            },
          },
        });

        const logFilePath = loggerInfo.logFilePath;

        if (!logFilePath) {
          throw new Error("Expected logger to create a log file path.");
        }

        const logText = await readFile(logFilePath, "utf8");
        const logLines = logText
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);

        expect(logLines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "tool_result",
              tool: "bash",
              command: 'printf "$SECRET_VALUE"',
              exitCode: 0,
              policy: expect.objectContaining({ kind: "allow_prefix" }),
              stdoutLength: 21,
              stderrLength: 0,
            }),
          ])
        );
        expect(logText).not.toContain("SECRET_COMMAND_OUTPUT");
      }
    );
  });

  it("logs project instruction source metadata for model prompts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-logging-"));
    await writeFile(join(workspace, "AGENTS.md"), "Use careful wording.\n");

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: "" }, async () => {
      const loggerInfo = createTopchesterLogger(workspace);
      const runtime = new TopchesterAgentRuntime({
        workspaceRoot: workspace,
        configLoadSpec: { workspaceRoot: workspace },
        baseConfig: {},
        runtimeConfigOverrides: { modelOverrides: {}, reasoningEffortByProvider: {} },
        config: {},
        devFlags: new Set(),
        logger: loggerInfo.logger,
        modelGateway: {
          async generateText() {
            return {
              text: "Done.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          },
        } as unknown as AppContext["modelGateway"],
      });

      await runtime.submitMessage([], "hello");

      const logFilePath = loggerInfo.logFilePath;

      if (!logFilePath) {
        throw new Error("Expected logger to create a log file path.");
      }

      const logLines = (await readFile(logFilePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const sourceMetadata = {
        path: "AGENTS.md",
        scopePath: ".",
        bytes: Buffer.byteLength("Use careful wording.\n"),
        truncated: false,
      };

      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "project_instructions_resolved",
            sourceCount: 1,
            sources: [sourceMetadata],
            truncated: false,
          }),
          expect.objectContaining({
            event: "model_prompt",
            projectInstructionSources: [sourceMetadata],
            projectInstructionsTruncated: false,
          }),
        ])
      );
    });
  });
});

async function withEnv(env: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }

    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}
