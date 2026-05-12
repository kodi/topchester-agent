import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
