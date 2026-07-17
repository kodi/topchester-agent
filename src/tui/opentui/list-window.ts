export const ACTIVE_ROW_MARKER = "❯";

export function getListWindowStart(itemCount: number, selectedIndex: number, visibleRows: number): number {
  const rows = Math.max(1, visibleRows);
  const count = Math.max(0, itemCount);
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, count - 1)));
  const centered = selected - Math.floor(rows / 2);
  return Math.max(0, Math.min(centered, Math.max(0, count - rows)));
}
