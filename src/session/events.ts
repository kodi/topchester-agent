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

export const sessionMetadataSchema = z.object({
  version: z.literal(SESSION_METADATA_VERSION),
  sessionId: z.string(),
  workspaceRoot: z.string().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  lastEventId: z.number().int().min(0),
});

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

const taskPlanItemPayloadSchema = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const taskPlanPayloadSchema = z.object({
  kind: z.literal("task_plan"),
  items: z.array(taskPlanItemPayloadSchema),
  updatedAt: isoTimestampSchema,
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

export const sessionEventPayloadSchema = z.discriminatedUnion("kind", [
  messagePayloadSchema,
  toolCallPayloadSchema,
  taskPlanPayloadSchema,
  statusPayloadSchema,
  knowledgeStatusPayloadSchema,
  choicePayloadSchema,
]);

export const sessionEventSchema = z.intersection(eventEnvelopeSchema, sessionEventPayloadSchema);

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
