import { ui } from "./ui.js";

export function printExitBanner(sessionId: string, durationMs: number): void {
  console.log("");
  console.log(`${ui.heading("session ended")} ${ui.label(`after ${formatDuration(durationMs)}`)}`);
  console.log(`${ui.label("To resume this session, run:")} ${ui.ok(`topchester --resume ${sessionId}`)}`);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  }
  return parts.join(" ");
}
