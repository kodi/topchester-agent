import { getToolDefinition, isToolName, type ToolCall } from "./registry.js";
import { parseXmlToolCall } from "./xml-parser.js";
import { type ToolCallSource } from "./types.js";

export function parseToolCall(text: string): ToolCall | undefined {
  return parseJsonToolCall(text);
}

export function parseToolCallWithSource(
  text: string,
  allowedSources: readonly ToolCallSource[] = ["text-json", "text-xml"]
): { call: ToolCall; source: ToolCallSource } | undefined {
  if (allowedSources.includes("text-json")) {
    const json = parseJsonToolCall(text);

    if (json) {
      return { call: json, source: "text-json" };
    }
  }

  if (allowedSources.includes("text-xml")) {
    const xml = parseXmlToolCall(text);

    if (xml) {
      return { call: xml, source: "text-xml" };
    }
  }

  return undefined;
}

export function parseNativeToolCall(toolName: string, args: unknown): ToolCall | undefined {
  if (!isToolName(toolName)) {
    return undefined;
  }

  const definition = getToolDefinition(toolName);
  const parsed = definition.argsSchema.safeParse(args);

  if (!parsed.success) {
    return undefined;
  }

  return {
    tool: definition.name,
    args: parsed.data,
  } as ToolCall;
}

function parseJsonToolCall(text: string): ToolCall | undefined {
  const trimmed = extractToolJsonCandidate(stripJsonFence(text.trim()));
  let value: unknown;

  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.tool !== "string") {
    return undefined;
  }

  if (!isToolName(value.tool)) {
    return undefined;
  }

  const definition = getToolDefinition(value.tool);
  const parsed = definition.argsSchema.safeParse(value.args);

  if (!parsed.success) {
    return undefined;
  }

  return {
    tool: definition.name,
    args: parsed.data,
  } as ToolCall;
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return match?.[1] ?? text;
}

function extractToolJsonCandidate(text: string): string {
  if (!text.startsWith("{")) {
    return text;
  }

  const endIndex = findJsonObjectEnd(text);

  return endIndex === undefined ? text : text.slice(0, endIndex + 1);
}

function findJsonObjectEnd(text: string): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
