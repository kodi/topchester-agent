export interface ContextOverflowClassification {
  overflow: boolean;
  maximumTokens?: number;
  requestedTokens?: number;
  source?: "reported" | "inferred";
  providerCode?: string;
}

export function classifyContextOverflow(error: unknown): ContextOverflowClassification {
  const record = asRecord(error);
  const records = collectErrorRecords(record);
  const status = firstDefined(records.flatMap((entry) => [numberValue(entry.status), numberValue(entry.statusCode)]));
  const code = firstDefined(records.map((entry) => stringValue(entry.code)));
  const message = records
    .flatMap((entry) => [stringValue(entry.message), stringValue(entry.error)])
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const structured =
    status === 413 ||
    ["context_length_exceeded", "max_tokens_exceeded", "prompt_too_long", "request_too_large"].includes(
      code?.toLowerCase() ?? ""
    );
  const patterned =
    /context (?:length|window).*(?:exceed|maximum|max)|(?:prompt|input).*(?:too long|too large)|maximum context length/iu.test(
      message
    );
  if (!structured && !patterned) return { overflow: false };

  const explicit = firstMatchingNumber(message, [
    /maximum context length is\s*([\d,]+)/iu,
    /context window (?:is|of)\s*([\d,]+)/iu,
    /max(?:imum)?(?:_input)? tokens?[:= ]+([\d,]+)/iu,
    /limit(?: is| of)?\s*([\d,]+)\s*tokens?/iu,
  ]);
  const requested = firstMatchingNumber(message, [
    /requested\s*([\d,]+)/iu,
    /resulted in\s*([\d,]+)\s*tokens?/iu,
    /you sent\s*([\d,]+)/iu,
  ]);
  const inferred = explicit === undefined && requested !== undefined ? Math.max(1, requested - 1) : undefined;
  return {
    overflow: true,
    ...(explicit === undefined
      ? inferred === undefined
        ? {}
        : { maximumTokens: inferred }
      : { maximumTokens: explicit }),
    ...(requested === undefined ? {} : { requestedTokens: requested }),
    ...(explicit !== undefined
      ? { source: "reported" as const }
      : inferred !== undefined
        ? { source: "inferred" as const }
        : {}),
    ...(code ? { providerCode: code } : {}),
  };
}

function firstMatchingNumber(message: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const value = match?.[1] ? Number(match[1].replaceAll(",", "")) : Number.NaN;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function collectErrorRecords(root: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!root) return [];
  const records = [root];
  for (let index = 0; index < records.length && index < 8; index += 1) {
    const record = records[index]!;
    for (const key of ["cause", "data", "response", "error", "body"]) {
      const nested = asRecord(record[key]);
      if (nested && !records.includes(nested)) records.push(nested);
    }
  }
  return records;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}
