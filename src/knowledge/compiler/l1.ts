import { z } from "zod";
import { isoUtcTimestampSchema, l1FileIdSchema, sha256HashSchema } from "./l1-entry.js";
import { type InventoryFile } from "./inventory.js";

export const l1QueueStatuses = ["queued", "in_progress", "completed", "failed", "changed", "missing_file"] as const;

export const l1QueueStatusSchema = z.enum(l1QueueStatuses);

export const l1QueueItemSchema = z
  .object({
    id: l1FileIdSchema,
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    hash: sha256HashSchema,
    status: l1QueueStatusSchema,
  })
  .strict()
  .refine((item) => item.id === `file:${item.path}`, {
    message: "L1 queue item id must match path",
    path: ["id"],
  });

export const l1QueueFileSchema = z
  .object({
    layer: z.literal("L1"),
    generatedAt: isoUtcTimestampSchema,
    queuedFiles: z.array(l1QueueItemSchema),
  })
  .strict();

export type L1QueueStatus = (typeof l1QueueStatuses)[number];
export type L1QueueItem = z.infer<typeof l1QueueItemSchema>;
export type L1QueueFile = z.infer<typeof l1QueueFileSchema>;

export function createL1QueueItem(file: InventoryFile): L1QueueItem {
  return l1QueueItemSchema.parse({
    ...file,
    id: `file:${file.path}`,
    status: "queued",
  });
}

export function createL1QueueFile(queuedFiles: L1QueueItem[], generatedAt: string): L1QueueFile {
  return l1QueueFileSchema.parse({
    layer: "L1",
    generatedAt,
    queuedFiles,
  });
}
