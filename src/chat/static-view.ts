import { type TaskPlanState } from "../agent/task-plan.js";
import { formatStartupTranscriptText, type TranscriptEntry } from "./transcript.js";

export function renderStaticView(options: {
  transcript: readonly TranscriptEntry[];
  workspaceLabel: string;
  modelLabel: string;
  status?: string;
  taskPlan?: TaskPlanState;
}): string {
  const transcript = options.transcript.flatMap(renderStaticTranscriptEntry);
  const plan = options.taskPlan?.items.flatMap((item) => [
    `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"} ${item.text}`,
  ]);
  return [
    ...transcript,
    "",
    ...(plan?.length ? [...plan, ""] : []),
    "┌──────────────────────────────────────────────────────────────────────┐",
    "│ >                                                                    │",
    "└──────────────────────────────────────────────────────────────────────┘",
    `● ${options.status ?? "ready"} ·  ${options.workspaceLabel} · ${options.modelLabel}`,
  ].join("\n");
}

export function renderStaticTranscriptEntry(entry: TranscriptEntry): string[] {
  switch (entry.kind) {
    case "startup":
      return formatStartupTranscriptText(entry).split("\n");
    case "system":
      return ["✦ System:", ...entry.text.split("\n").map((line) => `   ${line}`)];
    case "user":
      return ["▌", ...entry.text.split("\n").map((line) => `▌ ${line}`), "▌"];
    case "assistant":
      return [
        ...entry.text.split("\n"),
        ...(entry.meta ? [`   ─${"─".repeat(entry.meta.length + 1)}`, `   ↳ ${entry.meta}`] : []),
      ];
    case "reasoning":
      return entry.text.split("\n");
    case "tool_call":
      return [
        `   ${entry.label}${entry.resultSummary && !entry.label.includes(entry.resultSummary) ? ` ${entry.resultSummary}` : ""}`,
        ...(entry.diff?.split("\n").map((line) => `     ${line}`) ?? []),
      ];
    case "hook_status":
    case "permission_auto_approved":
      return [` ${entry.label}`];
    case "subagent":
      return [
        `   ↳ task: ${entry.title ?? entry.sessionId.slice(0, 8)} (${entry.status})`,
        ...(entry.text
          ?.split("\n")
          .slice(0, 8)
          .map((line) => `     ${line}`) ?? []),
      ];
    case "knowledge_status":
      return [`KB status: ${entry.status.kbPath} ${entry.status.kbExists ? "[ok]" : "[missing]"}`];
    case "choice":
      return [
        entry.title,
        ...(entry.body?.split("\n") ?? []),
        ...entry.actions.map((action, index) => `${index + 1}) ${action.label}`),
      ];
  }
}
