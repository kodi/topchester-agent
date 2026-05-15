import { type z } from "zod";
import { type Logger } from "pino";
import { type TaskPlanController } from "../task-plan.js";
import { type AgentProfile, type ToolPermissionView } from "../profiles.js";
import { type SubagentManager } from "../subagents.js";
import { type TopchesterConfig } from "../../config/index.js";

export interface ToolContext {
  workspaceRoot: string;
  pathEnv?: string;
  runCommandApprovals?: RunCommandApprovalContext;
  logger?: Logger;
  config?: TopchesterConfig;
  taskPlan?: TaskPlanController;
  profile?: AgentProfile;
  permissions?: ToolPermissionView;
  subagents?: SubagentManager;
  eventSink?: (event: import("../events.js").AgentRuntimeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

export interface RunCommandApprovalContext {
  allowExactCommands?: readonly string[];
}

export interface ToolCall<Name extends string = string, Args = unknown> {
  tool: Name;
  args: Args;
}

export type ToolCallSource = "native" | "text-json" | "text-xml";

export type ToolProtocol = "native-openai-compatible" | "text-json" | "text-xml";

export type ToolProtocolOverride = "auto" | "native" | "text-json" | "text-xml";

export interface ToolProtocolAttempt {
  protocol: ToolProtocol;
  status: "used" | "skipped" | "failed" | "fallback";
  reason?: string;
}

export interface ModelToolCall<Name extends string = string, Args = unknown> extends ToolCall<Name, Args> {
  id: string;
  source: ToolCallSource;
}

export interface ToolResult<Name extends string = string> {
  tool: Name;
  path?: string;
  content: string;
  command?: string;
  warning?: string;
}

export interface ToolErrorResult<Name extends string = string> extends ToolResult<Name> {
  error: string;
}

export type ToolExecutionResult<Result extends ToolResult = ToolResult> = Result | ToolErrorResult;

export function isToolErrorResult(result: ToolResult): result is ToolErrorResult {
  return "error" in result && typeof result.error === "string";
}

export interface ToolDefinition<Name extends string, Args, Result extends ToolResult<Name> = ToolResult<Name>> {
  name: Name;
  description: string;
  prompt: string;
  argsSchema: z.ZodType<Args>;
  parallelSafe?: boolean;
  mutatesWorkspace?: boolean;
  requiresExclusiveWorkspace?: boolean;
  resourceKeys?: (args: any) => readonly string[];
  execute(context: ToolContext, args: Args): Promise<Result>;
}

export type ToolCallForDefinition<Definition> =
  Definition extends ToolDefinition<infer Name, infer Args, infer _Result> ? ToolCall<Name, Args> : never;

export type ToolResultForDefinition<Definition> =
  Definition extends ToolDefinition<infer _Name, infer _Args, infer Result> ? Result : never;

export function defineTool<const Name extends string, Args, Result extends ToolResult<Name>>(
  definition: ToolDefinition<Name, Args, Result>
): ToolDefinition<Name, Args, Result> {
  return definition;
}
