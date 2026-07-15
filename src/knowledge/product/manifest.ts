import { z } from "zod";
import { isoUtcTimestampSchema, sha256HashSchema } from "../compiler/l1-entry.js";

export const productKnowledgeManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    sourceId: z.literal("topchester"),
    sourceKind: z.literal("builtin-product"),
    productVersion: z.string().min(1),
    compiler: z.object({ name: z.string().min(1), version: z.number().int().positive() }).strict(),
    generatedAt: isoUtcTimestampSchema,
    sourceRevision: z.string().min(1).optional(),
    packSpecHash: sha256HashSchema,
    sourceFileCount: z.number().int().nonnegative(),
    entryCount: z.number().int().nonnegative(),
    sourceFiles: z
      .array(z.object({ path: z.string().min(1), contentHash: sha256HashSchema }).strict())
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "Duplicate source paths"),
  })
  .strict();

export type ProductKnowledgeManifest = z.infer<typeof productKnowledgeManifestSchema>;

export function parseProductKnowledgeManifest(value: unknown): ProductKnowledgeManifest {
  return productKnowledgeManifestSchema.parse(value);
}
