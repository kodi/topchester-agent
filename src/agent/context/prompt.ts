import { createHash } from "node:crypto";

export type PromptSegmentKind =
  | "conversation"
  | "current_user"
  | "knowledge"
  | "hook_context"
  | "tool_result"
  | "steering"
  | "continuation"
  | "repair";

export interface PromptSegment {
  kind: PromptSegmentKind;
  text: string;
  retention: "required" | "recent" | "replaceable";
  associationId?: string;
  metadata?: Record<string, string | number | boolean>;
  separatorBefore?: "\n" | "\n\n";
}

export function renderPromptSegments(segments: readonly PromptSegment[]): string {
  return segments.reduce(
    (rendered, segment) =>
      segment.text ? `${rendered}${rendered ? (segment.separatorBefore ?? "\n\n") : ""}${segment.text}` : rendered,
    ""
  );
}

export function fingerprintPromptSegments(segments: readonly PromptSegment[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        segments.map(({ kind, text, retention, associationId, metadata, separatorBefore }) => ({
          kind,
          text,
          retention,
          associationId,
          metadata,
          separatorBefore,
        }))
      )
    )
    .digest("hex");
}
