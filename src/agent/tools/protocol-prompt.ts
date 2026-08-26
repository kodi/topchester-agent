import { type RuntimeToolDefinition } from "./catalog.js";
import { type ToolProtocolOverride } from "./types.js";

const TOOL_PROTOCOL_START = "<!-- topchester-tool-protocol:start -->";
const TOOL_PROTOCOL_END = "<!-- topchester-tool-protocol:end -->";

export function withToolProtocolInstructions(
  system: string,
  tools: readonly RuntimeToolDefinition[],
  protocol: ToolProtocolOverride
): string {
  const base = stripToolProtocolInstructions(system);
  const lines =
    protocol === "text-json"
      ? formatTextJsonInstructions(tools)
      : protocol === "text-xml"
        ? formatTextXmlInstructions(tools)
        : [
            "# Tool protocol",
            "Use the provided native tool interface. Independent read-only tool calls may run in parallel.",
          ];

  return [base, "", TOOL_PROTOCOL_START, ...lines, TOOL_PROTOCOL_END].join("\n");
}

function stripToolProtocolInstructions(system: string): string {
  const start = system.indexOf(TOOL_PROTOCOL_START);

  if (start === -1) {
    return system.trimEnd();
  }

  const end = system.indexOf(TOOL_PROTOCOL_END, start);

  return (
    end === -1 ? system.slice(0, start) : `${system.slice(0, start)}${system.slice(end + TOOL_PROTOCOL_END.length)}`
  ).trimEnd();
}

function formatTextJsonInstructions(tools: readonly RuntimeToolDefinition[]): string[] {
  return [
    "# Tool protocol",
    "Native tool calls are unavailable. To use a tool, output exactly one tool JSON object and no prose, markdown, or additional JSON.",
    "After the tool result, output the next single tool JSON object or a final plain-text answer.",
    "",
    "Available tools:",
    ...tools.map((tool) => tool.prompt),
  ];
}

function formatTextXmlInstructions(tools: readonly RuntimeToolDefinition[]): string[] {
  return [
    "# Tool protocol",
    "Native tool calls are unavailable. To use a tool, output exactly one XML tool call and no prose or markdown.",
    'Use this form: <tool_call>tool_name {"argument":"value"}</tool_call>',
    "After the tool result, output the next single XML tool call or a final plain-text answer.",
    "",
    "Available tools:",
    ...tools.map(formatXmlToolLine),
  ];
}

function formatXmlToolLine(tool: RuntimeToolDefinition): string {
  const markers = [" To use it, reply with only JSON: ", " Example: "];
  const match = markers
    .map((marker) => ({ marker, index: tool.prompt.lastIndexOf(marker) }))
    .filter(({ index }) => index !== -1)
    .sort((left, right) => right.index - left.index)[0];

  if (!match) {
    return `${tool.name}: ${tool.description}`;
  }

  const guidance = tool.prompt.slice(0, match.index);
  const exampleText = tool.prompt.slice(match.index + match.marker.length);

  try {
    const example = JSON.parse(exampleText) as { tool?: unknown; args?: unknown };

    if (example.tool === tool.name && example.args && typeof example.args === "object") {
      return `${guidance} XML example: <tool_call>${tool.name} ${JSON.stringify(example.args)}</tool_call>`;
    }
  } catch {
    // Fall back to the protocol-neutral native description below.
  }

  return `${tool.name}: ${tool.description}`;
}
