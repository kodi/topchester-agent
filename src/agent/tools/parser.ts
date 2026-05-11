import { getToolDefinition, isToolName, type ToolCall } from "./registry.js";

export function parseToolCall(text: string): ToolCall | undefined {
  const trimmed = stripJsonFence(text.trim());
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
