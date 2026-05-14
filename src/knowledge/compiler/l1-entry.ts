import { z } from "zod";

export const l1FileEntrySchemaPath = "../schema/file-entry.v1.json";
export const l1FileScanStatuses = [
  "current",
  "changed",
  "missing_entry",
  "missing_file",
  "suspect",
  "invalid",
] as const;
export const l1ConfidenceLevels = ["low", "medium", "high"] as const;
export const l1FileRoles = ["source", "test", "config", "doc", "script", "unknown"] as const;

const nonEmptyStringSchema = z.string().min(1);

export const sha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const isoUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected a valid UTC ISO timestamp" });

export const l1FileIdSchema = nonEmptyStringSchema.refine((value) => value.startsWith("file:"), {
  message: "Expected a file: id",
});
export const l1ModuleIdSchema = nonEmptyStringSchema.refine((value) => value.startsWith("module:"), {
  message: "Expected a module: id",
});
export const l1FeatureIdSchema = nonEmptyStringSchema.refine((value) => value.startsWith("feature:"), {
  message: "Expected a feature: id",
});

export const l1FileSymbolSchema = z
  .object({
    id: nonEmptyStringSchema.refine((value) => value.startsWith("symbol:"), { message: "Expected a symbol: id" }),
    kind: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    exported: z.boolean(),
    summary: nonEmptyStringSchema.optional(),
  })
  .strict();

export const l1FileEvidenceSchema = z
  .object({
    kind: nonEmptyStringSchema,
    value: nonEmptyStringSchema,
  })
  .strict();

export const l1FileEntrySchema = z
  .object({
    $schema: z.literal(l1FileEntrySchemaPath),
    id: l1FileIdSchema,
    layer: z.literal("L1"),
    type: z.literal("file"),
    path: nonEmptyStringSchema,
    language: nonEmptyStringSchema,
    content_hash: sha256HashSchema,
    size_bytes: z.number().int().nonnegative(),
    last_scanned_at: isoUtcTimestampSchema,
    scan_status: z.enum(l1FileScanStatuses),
    file_role: z.enum(l1FileRoles).default("unknown"),
    summary: nonEmptyStringSchema,
    responsibilities: z.array(nonEmptyStringSchema),
    symbols: z.array(l1FileSymbolSchema),
    imports: z.array(l1FileIdSchema),
    exports: z.array(nonEmptyStringSchema),
    module_ids: z.array(l1ModuleIdSchema),
    feature_ids: z.array(l1FeatureIdSchema),
    test_ids: z.array(l1FileIdSchema),
    declared_test_targets: z.array(l1FileIdSchema).default([]),
    likely_test_targets: z.array(l1FileIdSchema).default([]),
    tested_by: z.array(l1FileIdSchema).default([]),
    evidence: z.array(l1FileEvidenceSchema),
    confidence: z.enum(l1ConfidenceLevels),
  })
  .strict()
  .refine((entry) => entry.id === `file:${entry.path}`, {
    message: "File entry id must match path",
    path: ["id"],
  });

export type L1FileScanStatus = (typeof l1FileScanStatuses)[number];
export type L1ConfidenceLevel = (typeof l1ConfidenceLevels)[number];
export type L1FileRole = (typeof l1FileRoles)[number];
export type L1FileSymbol = z.infer<typeof l1FileSymbolSchema>;
export type L1FileEvidence = z.infer<typeof l1FileEvidenceSchema>;
export type L1FileEntry = z.infer<typeof l1FileEntrySchema>;

export function parseL1FileEntry(value: unknown): L1FileEntry {
  return l1FileEntrySchema.parse(value);
}
