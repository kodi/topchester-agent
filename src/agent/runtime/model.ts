import { type AppContext } from "../../app/context.js";
import { type ModelAgentResult, type ModelReasoningSink } from "../../model/index.js";
import { hasOpenTaskPlan, type TaskPlanState } from "../task-plan.js";
import {
  createToolCatalog,
  parseToolCallWithSource,
  type ModelToolCall,
  type RuntimeToolDefinition,
  type ToolCall,
  type ToolCatalog,
  type ToolProtocol,
  type ToolProtocolAttempt,
  type ToolProtocolOverride,
} from "../tools.js";

type AgentStepTools = readonly RuntimeToolDefinition[];

/**
 * Calls the configured model gateway for a single agent step and normalizes
 * the result into the newer `ModelAgentResult` shape. Gateways that implement
 * native agent stepping receive the tool registry directly; older text-only
 * gateways fall back to parsing a JSON or XML tool call out of the model text
 * so the rest of the runtime can use the same tool loop.
 */
export async function generateAgentStep(
  context: AppContext,
  request: {
    purpose: "agent.primary";
    system: string;
    prompt: string;
    sessionId?: string;
    abortSignal?: AbortSignal;
    toolProtocol?: ToolProtocolOverride;
    onReasoning?: ModelReasoningSink;
    tools: AgentStepTools;
    toolCatalog?: ToolCatalog;
  }
): Promise<ModelAgentResult> {
  if ("generateAgentStep" in context.modelGateway && typeof context.modelGateway.generateAgentStep === "function") {
    return context.modelGateway.generateAgentStep({
      ...request,
    });
  }

  const result = await context.modelGateway.generateText(request);
  const catalog = request.toolCatalog ?? createToolCatalog(request.tools);
  const parsed = parseToolCallWithSource(result.text, ["text-json", "text-xml"], catalog);
  const toolProtocol: ToolProtocol = parsed?.source === "text-xml" ? "text-xml" : "text-json";
  const attempts: ToolProtocolAttempt[] = [{ protocol: toolProtocol, status: "used", reason: "legacy gateway" }];

  return {
    ...result,
    toolCalls: parsed
      ? [
          {
            id: `${parsed.source}-0`,
            tool: parsed.call.tool,
            args: parsed.call.args,
            source: parsed.source,
          } as ModelToolCall,
        ]
      : [],
    toolProtocol,
    protocolAttempts: attempts,
    providerRejectedTools: false,
    warnings: [],
    openRouterRoutingApplied: false,
  };
}

export function getExecutableModelToolCalls(result: ModelAgentResult, toolCatalog?: ToolCatalog): ModelToolCall[] {
  if (result.toolCalls.length > 0) {
    return result.toolCalls;
  }

  const allowedSources =
    result.toolProtocol === "text-xml"
      ? (["text-xml"] as const)
      : result.toolProtocol === "text-json"
        ? (["text-json"] as const)
        : (["text-json", "text-xml"] as const);
  const parsed = toolCatalog
    ? parseToolCallWithSource(result.text, allowedSources, toolCatalog)
    : parseToolCallWithSource(result.text, allowedSources);

  if (!parsed) {
    return [];
  }

  return [
    {
      id: `${parsed.source}-runtime-recovered-0`,
      tool: parsed.call.tool,
      args: parsed.call.args,
      source: parsed.source,
    } as ModelToolCall,
  ];
}

export function getSuppressiblePlanTodoAnswer(
  call: ToolCall,
  modelText: string,
  currentPlan: TaskPlanState
): string | undefined {
  if (call.tool !== "plan_todo" || hasOpenTaskPlan(currentPlan)) {
    return undefined;
  }

  const items = (call.args as { items?: unknown }).items;

  if (!Array.isArray(items) || items.some((item) => !isCompletedPlanTodoItem(item))) {
    return undefined;
  }

  const parsed = parseToolCallWithSource(modelText, ["text-json"]);

  return parsed?.remainder ? parsed.remainder : undefined;
}

export function stripSuppressiblePlanTodoPrefix(modelText: string, currentPlan: TaskPlanState): string | undefined {
  const parsed = parseToolCallWithSource(modelText, ["text-json"]);

  if (!parsed) {
    return undefined;
  }

  return getSuppressiblePlanTodoAnswer(parsed.call, modelText, currentPlan);
}

export function readToolProtocolEnvOverride(): ToolProtocolOverride | undefined {
  const value = process.env.TOPCHESTER_TOOL_PROTOCOL;

  if (value === "auto" || value === "native" || value === "text-json" || value === "text-xml") {
    return value;
  }

  return undefined;
}

function isCompletedPlanTodoItem(item: unknown): boolean {
  return Boolean(
    item && typeof item === "object" && "status" in item && (item as { status?: unknown }).status === "completed"
  );
}
