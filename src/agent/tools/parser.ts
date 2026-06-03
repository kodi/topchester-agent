import { getToolDefinition, isToolName, type ToolCall } from "./registry.js";
import { parseXmlToolCall } from "./xml-parser.js";
import { type ToolCallSource } from "./types.js";

export interface ToolCallParseRejection {
  source: ToolCallSource;
  tool: string;
  reason: string;
}

export function parseToolCall(text: string): ToolCall | undefined {
  return parseJsonToolCall(text)?.call;
}

export function parseToolCallWithSource(
  text: string,
  allowedSources: readonly ToolCallSource[] = ["text-json", "text-xml"]
): { call: ToolCall; source: ToolCallSource; remainder: string } | undefined {
  if (allowedSources.includes("text-json")) {
    const json = parseJsonToolCall(text);

    if (json) {
      return { ...json, source: "text-json" };
    }
  }

  if (allowedSources.includes("text-xml")) {
    const xml = parseXmlToolCall(text);

    if (xml) {
      return { call: xml, source: "text-xml", remainder: "" };
    }
  }

  return undefined;
}

export function parseToolCallRejection(
  text: string,
  allowedSources: readonly ToolCallSource[] = ["text-json", "text-xml"]
): ToolCallParseRejection | undefined {
  if (!allowedSources.includes("text-json")) {
    return undefined;
  }

  const { json } = extractToolJsonCandidate(stripJsonFence(text.trim()));
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    try {
      value = JSON.parse(escapeControlCharactersInJsonStrings(json));
    } catch {
      return undefined;
    }
  }

  if (!isRecord(value) || typeof value.tool !== "string" || !isToolName(value.tool)) {
    return undefined;
  }

  const definition = getToolDefinition(value.tool);
  const parsed = definition.argsSchema.safeParse(value.args);

  if (parsed.success) {
    return undefined;
  }

  return {
    source: "text-json",
    tool: definition.name,
    reason: parsed.error.issues.map(formatZodIssue).join("; "),
  };
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

function parseJsonToolCall(text: string): { call: ToolCall; remainder: string } | undefined {
  const candidate = extractToolJsonCandidate(stripJsonFence(text.trim()));
  const { json } = candidate;
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    try {
      value = JSON.parse(escapeControlCharactersInJsonStrings(json));
    } catch {
      return undefined;
    }
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
    call: {
      tool: definition.name,
      args: parsed.data,
    } as ToolCall,
    remainder: candidate.remainder.trim(),
  };
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return match?.[1] ?? text;
}

function extractToolJsonCandidate(text: string): { json: string; remainder: string } {
  const startIndex = findToolJsonObjectStart(text);

  if (startIndex === undefined) {
    return { json: text, remainder: "" };
  }

  const candidate = text.slice(startIndex);
  const endIndex = findJsonObjectEnd(candidate);

  return endIndex === undefined
    ? { json: text, remainder: "" }
    : {
        json: candidate.slice(0, endIndex + 1),
        remainder: `${text.slice(0, startIndex)}${candidate.slice(endIndex + 1)}`,
      };
}

function findToolJsonObjectStart(text: string): number | undefined {
  if (text.startsWith("{")) {
    return 0;
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }

    const lineStart = skipInlineWhitespace(text, index + 1);

    if (text[lineStart] === "{") {
      return lineStart;
    }
  }

  return undefined;
}

function skipInlineWhitespace(text: string, startIndex: number): number {
  let index = startIndex;

  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }

  return index;
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

function escapeControlCharactersInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!inString) {
      result += char;

      if (char === '"') {
        inString = true;
      }

      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      result += "\\n";
    } else if (char === "\r") {
      result += "\\r";
    } else if (char === "\t") {
      result += "\\t";
    } else {
      result += char;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatZodIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "args";

  return `${path}: ${issue.message}`;
}
