import { z } from "zod";

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

const toolCallPayloadSchema = z.object({
  kind: z.literal("tool_call"),
  label: z.string(),
  call: z.record(z.string(), jsonValueSchema),
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

export const sessionEventPayloadSchema = z.discriminatedUnion("kind", [
  messagePayloadSchema,
  toolCallPayloadSchema,
  hookStatusPayloadSchema,
  taskPlanPayloadSchema,
  instructionContextPayloadSchema,
  statusPayloadSchema,
  knowledgeStatusPayloadSchema,
  choicePayloadSchema,
  subagentStartedPayloadSchema,
  subagentEventPayloadSchema,
  subagentCompletedPayloadSchema,
  subagentFailedPayloadSchema,
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
