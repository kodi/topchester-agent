#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.argv.includes("--fail")) {
  console.error("fixture startup failed");
  process.exit(2);
}

const server = new Server(
  {
    name: "topchester-mcp-fixture",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name !== "echo") {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }

  const message = request.params.arguments?.message;

  return {
    content: [{ type: "text", text: typeof message === "string" ? message : "" }],
  };
});

await server.connect(new StdioServerTransport());
