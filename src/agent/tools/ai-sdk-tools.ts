import { tool, type ToolSet } from "ai";
import { type ToolDefinition } from "./types.js";

export function toAiSdkToolSet(definitions: readonly ToolDefinition<string, unknown>[]): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: definition.argsSchema,
      }),
    ])
  ) as ToolSet;
}
