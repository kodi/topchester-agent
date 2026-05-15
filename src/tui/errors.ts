export function formatPlainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "Unknown error";
}
