export interface KnowledgeProgressEvent {
  message: string;
}

export type KnowledgeProgressReporter = (event: KnowledgeProgressEvent) => void;

export function formatProgressBar(completed: number, total: number, width = 20): string {
  const safeTotal = Math.max(total, 0);
  const safeCompleted = safeTotal === 0 ? 0 : Math.min(Math.max(completed, 0), safeTotal);
  const filled = safeTotal === 0 ? width : Math.floor((safeCompleted / safeTotal) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatCountProgress(label: string, completed: number, total: number, detail?: string): string {
  const safeTotal = Math.max(total, 0);
  const safeCompleted = safeTotal === 0 ? 0 : Math.min(Math.max(completed, 0), safeTotal);
  const percent = safeTotal === 0 ? 100 : Math.floor((safeCompleted / safeTotal) * 100);
  const suffix = detail ? ` ${detail}` : "";
  return `${label} [${formatProgressBar(safeCompleted, safeTotal)}] ${safeCompleted}/${safeTotal} (${percent}%)${suffix}`;
}
