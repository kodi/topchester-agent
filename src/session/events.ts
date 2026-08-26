import { z } from "zod";
import { modelChoiceAssignmentSchema, modelPurposeSchema, reasoningEffortSchema } from "../config/index.js";

export const SESSION_EVENT_VERSION = 1;
export const SESSION_METADATA_VERSION = 1;

const isoTimestampSchema = z.string().datetime({ offset: true });
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const sessionMetadataBaseSchema = z.object({
  version: z.literal(SESSION_METADATA_VERSION),
  sessionId: z.string(),
  rootSessionId: z.string().optional(),
  parentSessionId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  forkedFromSessionId: z.string().optional(),
  forkedFromRootSessionId: z.string().optional(),
  source: z.enum(["user", "subagent"]).optional(),
  agentProfileId: z.string().optional(),
  title: z.string().optional(),
  workspaceRoot: z.string().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  lastEventId: z.number().int().min(0),
});

export const sessionMetadataSchema = sessionMetadataBaseSchema.transform((metadata) => ({
  ...metadata,
  rootSessionId: metadata.rootSessionId ?? metadata.sessionId,
  source: metadata.source ?? "user",
}));

const eventEnvelopeSchema = z.object({
  version: z.literal(SESSION_EVENT_VERSION),
  id: z.number().int().positive(),
  ts: isoTimestampSchema,
});

const messagePayloadSchema = z.object({
  kind: z.literal("message"),
  role: z.enum(["system", "user", "assistant"]),
  text: z.string(),
  meta: jsonValueSchema.optional(),
});

const permissionAutoApprovedPayloadSchema = z.object({
  kind: z.literal("permission_auto_approved"),
  permissionMode: z.literal("bash"),
  approvalMode: z.literal("auto_allow"),
  toolName: z.string(),
  command: z.string(),
  workdir: z.string(),
  reason: z.string(),
  label: z.string(),
  toolCallId: z.string().optional(),
});

const toolCallPayloadSchema = z.object({
  kind: z.literal("tool_call"),
  label: z.string(),
  call: z.record(z.string(), jsonValueSchema),
  diff: z.string().optional(),
});

const hookStatusPayloadSchema = z.object({
  kind: z.literal("hook_status"),
  eventName: z.string(),
  statusMessage: z.string(),
  label: z.string(),
});

const taskPlanItemPayloadSchema = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const taskPlanPayloadSchema = z.object({
  kind: z.literal("task_plan"),
  items: z.array(taskPlanItemPayloadSchema),
  updatedAt: isoTimestampSchema,
});

const instructionContextSourcePayloadSchema = z.object({
  path: z.string(),
  scopePath: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const instructionContextPayloadSchema = z.object({
  kind: z.literal("instruction_context"),
  sources: z.array(instructionContextSourcePayloadSchema),
});

const statusPayloadSchema = z.object({
  kind: z.literal("status"),
  status: z.string(),
});

const runtimeConfigPayloadSchema = z.object({
  kind: z.literal("runtime_config"),
  modelOverrides: z.partialRecord(modelPurposeSchema, modelChoiceAssignmentSchema).optional(),
  // Read compatibility for sessions written before purpose-keyed overrides.
  activeModel: modelChoiceAssignmentSchema.optional(),
  reasoningEffortByProvider: z.record(z.string().min(1), reasoningEffortSchema),
});

const knowledgeStatusPayloadSchema = z.object({
  kind: z.literal("knowledge_status"),
  status: z.record(z.string(), jsonValueSchema),
});

const choicePayloadSchema = z.object({
  kind: z.literal("choice"),
  tone: z.enum(["info", "warning"]),
  title: z.string(),
  body: z.string().optional(),
  actions: z.array(
    z.object({
      label: z.string(),
      value: z.string().optional(),
    })
  ),
});

const subagentLifecycleBasePayloadSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string(),
  parentToolCallId: z.string(),
});

const subagentStartedPayloadSchema = subagentLifecycleBasePayloadSchema.extend({
  kind: z.literal("subagent_started"),
  agentProfileId: z.string().optional(),
  title: z.string().optional(),
});

const subagentEventPayloadSchema = subagentLifecycleBasePayloadSchema.extend({
  kind: z.literal("subagent_event"),
  event: z.record(z.string(), jsonValueSchema),
});

const subagentCompletedPayloadSchema = subagentLifecycleBasePayloadSchema.extend({
  kind: z.literal("subagent_completed"),
  result: z.string().optional(),
});

const subagentFailedPayloadSchema = subagentLifecycleBasePayloadSchema.extend({
  kind: z.literal("subagent_failed"),
  error: z.string(),
});

const contextRouteSchema = z.object({
  providerId: z.string().min(1),
  baseURL: z.string().min(1),
  modelId: z.string().min(1),
});

const contextCapacitySchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  source: z.enum(["config", "provider", "catalog", "error-reported", "error-inferred", "assumed", "unknown"]),
  confidence: z.enum(["authoritative", "reported", "catalog", "inferred", "assumed", "unknown"]),
  observedAt: isoTimestampSchema.optional(),
});

const contextUsageSnapshotSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  trailingEstimatedTokens: z.number().int().nonnegative(),
  source: z.enum(["provider", "local-estimate"]),
  estimated: z.boolean(),
  route: contextRouteSchema,
  asOfModelCall: z.number().int().nonnegative(),
  requestBaseFingerprint: z.string(),
  observedAt: isoTimestampSchema,
});

const contextBudgetSchema = z.object({
  capacity: contextCapacitySchema,
  usedTokens: z.number().int().nonnegative(),
  hardPromptBudget: z.number().int().positive().optional(),
  compactAtTokens: z.number().int().positive().optional(),
  targetTokens: z.number().int().positive().optional(),
  reserveTokens: z.number().int().nonnegative().optional(),
  rawRemainingTokens: z.number().int().nonnegative().optional(),
  safeRemainingTokens: z.number().int().nonnegative().optional(),
  uncertaintyTokens: z.number().int().nonnegative(),
});

const contextStatusSchema = z.object({
  route: contextRouteSchema,
  usage: contextUsageSnapshotSchema,
  budget: contextBudgetSchema,
  compactionsThisSession: z.number().int().nonnegative(),
  compactionsThisTurn: z.number().int().nonnegative(),
});

const projectionSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transcript_ref"), eventId: z.number().int().positive() }),
  z.object({
    kind: z.literal("inline"),
    segmentKind: z.enum([
      "current_user",
      "knowledge",
      "tool_result",
      "hook_context",
      "steering",
      "continuation",
      "turn",
    ]),
    text: z.string().min(1),
    role: z.enum(["user", "assistant"]).optional(),
    toolAssociationId: z.string().optional(),
  }),
]);

const modelProjectionSchema = z.object({
  version: z.literal(1),
  summary: z.string().optional(),
  segments: z.array(projectionSegmentSchema),
});

const contextUsagePayloadSchema = z.object({
  kind: z.literal("context_usage"),
  status: contextStatusSchema,
});

const contextCompactionPayloadSchema = z.object({
  kind: z.literal("context_compaction"),
  projectionVersion: z.literal(1),
  reason: z.enum(["manual", "threshold", "overflow", "model-switch"]),
  focus: z.string().optional(),
  projection: modelProjectionSchema,
  retainedFromEventId: z.number().int().positive().optional(),
  beforeTokens: z.number().int().nonnegative(),
  afterEstimatedTokens: z.number().int().nonnegative(),
  route: contextRouteSchema,
  capacity: contextCapacitySchema,
  status: contextStatusSchema,
});

export const sessionEventPayloadSchema = z.discriminatedUnion("kind", [
  messagePayloadSchema,
  permissionAutoApprovedPayloadSchema,
  toolCallPayloadSchema,
  hookStatusPayloadSchema,
  taskPlanPayloadSchema,
  instructionContextPayloadSchema,
  statusPayloadSchema,
  runtimeConfigPayloadSchema,
  knowledgeStatusPayloadSchema,
  choicePayloadSchema,
  subagentStartedPayloadSchema,
  subagentEventPayloadSchema,
  subagentCompletedPayloadSchema,
  subagentFailedPayloadSchema,
  contextUsagePayloadSchema,
  contextCompactionPayloadSchema,
]);

export const sessionEventSchema = z.intersection(eventEnvelopeSchema, sessionEventPayloadSchema);

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export interface SubagentSessionReference {
  sessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
}

export const sessionEventPayload = {
  subagentStarted(
    reference: SubagentSessionReference,
    options: { agentProfileId?: string; title?: string } = {}
  ): SessionEventPayload {
    return { kind: "subagent_started", ...reference, ...options };
  },

  subagentEvent(reference: SubagentSessionReference, event: Record<string, unknown>): SessionEventPayload {
    return { kind: "subagent_event", ...reference, event };
  },

  subagentCompleted(reference: SubagentSessionReference, result?: string): SessionEventPayload {
    return result === undefined
      ? { kind: "subagent_completed", ...reference }
      : { kind: "subagent_completed", ...reference, result };
  },

  subagentFailed(reference: SubagentSessionReference, error: string): SessionEventPayload {
    return { kind: "subagent_failed", ...reference, error };
  },
} as const;

export function isSubagentSessionPayload(
  payload: SessionEventPayload
): payload is Extract<SessionEventPayload, { kind: `subagent_${string}` }> {
  return payload.kind.startsWith("subagent_");
}
