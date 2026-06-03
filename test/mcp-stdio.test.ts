import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/agent/mcp/manager.js";
import { createMcpToolDefinitions, toMcpModelToolName } from "../src/agent/mcp/tools.js";
import { createToolCatalog, executeToolCall } from "../src/agent/tools.js";
import { type TopchesterConfig } from "../src/config/index.js";

const fixtureServerPath = join(process.cwd(), "test/fixtures/mcp/stdio-server.js");

describe("stdio MCP manager", () => {
  it("connects to a configured stdio server and lists tools", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath],
          env: {},
          enabled: true,
          timeoutMs: 5000,
        },
      },
    });

    await manager.connectAll();

    expect(manager.statuses()).toEqual([{ state: "connected", serverName: "fixture", toolCount: 1 }]);
    expect(manager.tools()).toEqual([
      {
        serverName: "fixture",
        tool: {
          name: "echo",
          description: "Echo a string value.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      },
    ]);

    await manager.close();
  });

  it("records disabled servers without starting them", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        disabled_fixture: {
          type: "stdio",
          command: "definitely-not-a-real-command",
          args: [],
          env: {},
          enabled: false,
        },
      },
    });

    await manager.connectAll();

    expect(manager.statuses()).toEqual([
      {
        state: "disabled",
        serverName: "disabled_fixture",
        message: "MCP server is disabled in config.",
      },
    ]);
    expect(manager.connectedServers()).toEqual([]);
    expect(manager.tools()).toEqual([]);
  });

  it("records startup failures and exposes no tools", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath, "--fail"],
          env: { SECRET_VALUE: "do-not-log" },
          enabled: true,
          timeoutMs: 5000,
        },
      },
    });

    await manager.connectAll();

    expect(manager.statuses()).toEqual([
      expect.objectContaining({
        state: "failed",
        serverName: "fixture",
        stderr: "fixture startup failed",
      }),
    ]);
    expect(manager.statuses()[0]).not.toEqual(
      expect.objectContaining({ stderr: expect.stringContaining("do-not-log") })
    );
    expect(manager.connectedServers()).toEqual([]);
    expect(manager.tools()).toEqual([]);
  });

  it("closes connected clients", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath],
          env: {},
          enabled: true,
          timeoutMs: 5000,
        },
      },
    });

    await manager.connectAll();
    const [server] = manager.connectedServers();

    await manager.close();

    expect(manager.connectedServers()).toEqual([]);
    await expect(server?.client.listTools()).rejects.toThrow();
  });

  it("accepts the loaded config shape", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const config = {
      mcp: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath],
          env: {},
          enabled: true,
        },
      },
    } satisfies TopchesterConfig;
    const manager = new McpManager({ workspaceRoot, config: config.mcp });

    await manager.connectAll();

    expect(manager.statuses()).toEqual([{ state: "connected", serverName: "fixture", toolCount: 1 }]);

    await manager.close();
  });

  it("converts listed MCP tools into executable dynamic Topchester tools", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath],
          env: {},
          enabled: true,
          timeoutMs: 5000,
          enabledTools: ["echo"],
        },
      },
    });

    await manager.connectAll();
    const converted = createMcpToolDefinitions(manager.connectedServers());
    const catalog = createToolCatalog(converted.definitions);

    expect(converted.errors).toEqual([]);
    expect(converted.definitions.map((definition) => definition.name)).toEqual(["mcp_fixture_echo"]);
    await expect(
      executeToolCall(
        workspaceRoot,
        {
          tool: "mcp_fixture_echo",
          args: { message: "hello from mcp" },
        },
        { toolCatalog: catalog }
      )
    ).resolves.toEqual({
      tool: "mcp_fixture_echo",
      content: "hello from mcp",
    });

    await manager.close();
  });

  it("sanitizes MCP model-facing tool names", () => {
    expect(toMcpModelToolName("My Server", "echo-value")).toBe("mcp_my_server_echo_value");
    expect(toMcpModelToolName("!!!", "???")).toBe("mcp_tool_tool");
  });

  it("filters enabledTools and reports exposure cap errors", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-mcp-"));
    const manager = new McpManager({
      workspaceRoot,
      config: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixtureServerPath],
          env: {},
          enabled: true,
          timeoutMs: 5000,
          enabledTools: ["missing"],
        },
      },
    });

    await manager.connectAll();
    const filtered = createMcpToolDefinitions(manager.connectedServers());

    expect(filtered.definitions).toEqual([]);
    expect(filtered.errors).toEqual(['MCP server "fixture" enabledTools references missing tool "missing".']);

    const [server] = manager.connectedServers();
    const capped = createMcpToolDefinitions([{ ...server!, config: { ...server!.config, enabledTools: undefined } }], {
      maxExposedTools: 0,
    });

    expect(capped.definitions).toEqual([]);
    expect(capped.errors).toEqual([
      'MCP server "fixture" exposes 1 tools, above the V0 cap of 0; configure enabledTools to expose a smaller set.',
    ]);

    await manager.close();
  });

  it("detects sanitized MCP tool name collisions", () => {
    const converted = createMcpToolDefinitions([
      {
        serverName: "fixture",
        config: {
          type: "stdio",
          command: process.execPath,
          args: [],
          env: {},
          enabled: true,
        },
        client: {} as never,
        transport: {} as never,
        stderr: () => undefined,
        tools: [
          { name: "echo-value", inputSchema: { type: "object" } },
          { name: "echo value", inputSchema: { type: "object" } },
        ],
      },
    ]);

    expect(converted.definitions.map((definition) => definition.name)).toEqual(["mcp_fixture_echo_value"]);
    expect(converted.errors).toEqual([
      'MCP tool name collision for "mcp_fixture_echo_value" between fixture/echo-value and fixture/echo value.',
    ]);
  });

  it("summarizes unsupported MCP result parts", async () => {
    const converted = createMcpToolDefinitions([
      {
        serverName: "fixture",
        config: {
          type: "stdio",
          command: process.execPath,
          args: [],
          env: {},
          enabled: true,
        },
        client: {
          async callTool() {
            return {
              content: [
                { type: "text", text: "plain text" },
                { type: "image", data: "abc", mimeType: "image/png" },
              ],
            };
          },
        } as never,
        transport: {} as never,
        stderr: () => undefined,
        tools: [{ name: "rich", inputSchema: { type: "object" } }],
      },
    ]);
    const [definition] = converted.definitions;

    await expect(definition?.execute({ workspaceRoot: "/tmp" }, {})).resolves.toEqual({
      tool: "mcp_fixture_rich",
      content: "plain text\nUnsupported MCP result parts omitted: image.",
    });
  });
});
