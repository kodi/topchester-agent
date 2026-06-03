import { getStaticOrCatalogToolDefinition, type ToolCatalog } from "./catalog.js";
import { type ToolCall } from "./types.js";

export function parseXmlToolCall(text: string, catalog?: ToolCatalog): ToolCall | undefined {
  const trimmed = text.trim();

  if (!trimmed.startsWith("<")) {
    return undefined;
  }

  return parseWrappedToolCall(trimmed, catalog) ?? parseNamedToolCall(trimmed, catalog);
}

function parseWrappedToolCall(text: string, catalog: ToolCatalog | undefined): ToolCall | undefined {
  const match = text.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/u);

  if (!match) {
    return undefined;
  }

  if (countMatches(text, /<tool_call>/gu) !== 1 || countMatches(text, /<\/tool_call>/gu) !== 1) {
    return undefined;
  }

  const body = match[1]?.trim() ?? "";
  const toolMatch = body.match(/^([a-z_][a-z0-9_]*)\b\s*([\s\S]*)$/u);

  if (!toolMatch || !getStaticOrCatalogToolDefinition(catalog, toolMatch[1]!)) {
    return undefined;
  }

  const argsText = toolMatch[2]?.trim() ?? "";
  const args = parseWrappedArgs(argsText);

  return parseKnownToolCall(toolMatch[1]!, args, catalog);
}

function parseNamedToolCall(text: string, catalog: ToolCatalog | undefined): ToolCall | undefined {
  const root = text.match(/^<([a-z_][a-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>$/u);

  if (!root || !getStaticOrCatalogToolDefinition(catalog, root[1]!)) {
    return undefined;
  }

  const toolName = root[1]!;

  if (countMatches(text, new RegExp(`<${toolName}>`, "gu")) !== 1) {
    return undefined;
  }

  const args = parseChildTagArgs(root[2] ?? "");

  return args === undefined ? undefined : parseKnownToolCall(toolName, args, catalog);
}

function parseWrappedArgs(text: string): unknown {
  if (text === "") {
    return {};
  }

  if (text.startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  if (text.startsWith("<")) {
    return parseChildTagArgs(text);
  }

  return parseKeyValueArgs(text);
}

function parseChildTagArgs(text: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let cursor = 0;
  const childPattern = /<([a-z_][a-z0-9_]*)>\s*([^<>]*?)\s*<\/\1>/gu;

  for (const match of text.matchAll(childPattern)) {
    if (match.index !== cursor && text.slice(cursor, match.index).trim() !== "") {
      return undefined;
    }

    const key = match[1]!;
    const value = match[2] ?? "";

    if (key in args) {
      return undefined;
    }

    args[key] = parseScalar(value);
    cursor = match.index + match[0].length;
  }

  if (text.slice(cursor).trim() !== "" || Object.keys(args).length === 0) {
    return undefined;
  }

  return args;
}

function parseKeyValueArgs(text: string): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  const pattern = /([a-z_][a-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/giu;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index !== cursor && text.slice(cursor, match.index).trim() !== "") {
      return undefined;
    }

    const key = match[1]!;

    if (key in args) {
      return undefined;
    }

    args[key] = parseScalar(match[2] ?? match[3] ?? match[4] ?? "");
    cursor = match.index + match[0].length;
  }

  if (text.slice(cursor).trim() !== "" || Object.keys(args).length === 0) {
    return undefined;
  }

  return args;
}

function parseKnownToolCall(toolName: string, args: unknown, catalog: ToolCatalog | undefined): ToolCall | undefined {
  const definition = getStaticOrCatalogToolDefinition(catalog, toolName);

  if (!definition) {
    return undefined;
  }

  const parsed = definition.argsSchema.safeParse(args);

  if (!parsed.success) {
    return undefined;
  }

  return {
    tool: definition.name,
    args: parsed.data,
  } as ToolCall;
}

function parseScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}
