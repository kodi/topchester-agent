import { type ConversationTurn } from "../conversation.js";
import { type ContextCapacity, type ContextRoute } from "./types.js";

export interface TranscriptProjectionSegment {
  kind: "transcript_ref";
  eventId: number;
}

export interface InlineProjectionSegment {
  kind: "inline";
  segmentKind: "current_user" | "knowledge" | "tool_result" | "hook_context" | "steering" | "continuation" | "turn";
  text: string;
  role?: "user" | "assistant";
  toolAssociationId?: string;
}

export type ProjectionSegment = TranscriptProjectionSegment | InlineProjectionSegment;

export interface ModelContextProjection {
  version: 1;
  summary?: string;
  segments: ProjectionSegment[];
}

export interface ContextCompactionSnapshot {
  projectionVersion: 1;
  reason: "manual" | "threshold" | "overflow" | "model-switch";
  focus?: string;
  projection: ModelContextProjection;
  retainedFromEventId?: number;
  beforeTokens: number;
  afterEstimatedTokens: number;
  route: ContextRoute;
  capacity: ContextCapacity;
}

export interface ReferencedTranscriptMessage {
  eventId: number;
  role: "user" | "assistant";
  text: string;
}

export const RETAINED_CONTINUATION_PREFIX = "[Retained active-turn continuation]\n";

export function validateProjection(
  projection: ModelContextProjection,
  messages: readonly ReferencedTranscriptMessage[]
): void {
  if (projection.version !== 1) throw new Error("Unsupported model projection version.");
  const available = new Set(messages.map((message) => message.eventId));
  const associations = new Map<string, { resultIndex?: number; continuationIndex?: number }>();
  let activeRuntimeSeen = false;
  let currentUserSeen = false;
  let baseContextSeen = false;
  for (let index = 0; index < projection.segments.length; index += 1) {
    const segment = projection.segments[index]!;
    if (segment.kind === "transcript_ref" && !available.has(segment.eventId)) {
      throw new Error(`Compacted model projection references missing transcript event ${segment.eventId}.`);
    }
    if (segment.kind === "transcript_ref" && activeRuntimeSeen) {
      throw new Error("Compacted model projection contains a transcript turn after active-turn continuation state.");
    }
    if (segment.kind === "transcript_ref") baseContextSeen = true;
    if (segment.kind === "inline" && !segment.text.trim()) {
      throw new Error("Compacted model projection contains an empty inline segment.");
    }
    if (segment.kind !== "inline") continue;
    if (segment.segmentKind === "knowledge") {
      if (baseContextSeen || activeRuntimeSeen) {
        throw new Error("Compacted model projection contains knowledge context after conversation state.");
      }
      if (segment.role || segment.toolAssociationId) {
        throw new Error("Compacted model projection contains malformed knowledge context.");
      }
      continue;
    }
    if (segment.segmentKind === "turn") {
      if (!segment.role) throw new Error("Compacted model projection contains a turn without a role.");
      if (activeRuntimeSeen) {
        throw new Error("Compacted model projection contains a completed turn after active-turn continuation state.");
      }
      baseContextSeen = true;
      continue;
    }
    if (segment.role) throw new Error("Only completed turn segments may define a role.");
    if (segment.segmentKind === "current_user") {
      if (currentUserSeen || activeRuntimeSeen) {
        throw new Error("Compacted model projection contains malformed current-user ordering.");
      }
      currentUserSeen = true;
      baseContextSeen = true;
      continue;
    }
    activeRuntimeSeen = true;
    if (segment.segmentKind === "tool_result" && !segment.toolAssociationId) {
      throw new Error("Compacted model projection contains a tool result without an association id.");
    }
    if (segment.toolAssociationId) {
      const association = associations.get(segment.toolAssociationId) ?? {};
      if (segment.segmentKind === "tool_result") association.resultIndex = index;
      if (segment.segmentKind === "continuation") association.continuationIndex = index;
      associations.set(segment.toolAssociationId, association);
    }
  }
  for (const [associationId, association] of associations) {
    if (association.resultIndex !== undefined && association.continuationIndex === undefined) {
      throw new Error(`Tool association ${associationId} has a result without continuation state.`);
    }
    if (
      association.resultIndex !== undefined &&
      association.continuationIndex !== undefined &&
      association.continuationIndex < association.resultIndex
    ) {
      throw new Error(`Tool association ${associationId} has continuation state before its result.`);
    }
  }
}

export function projectionToConversationTurns(
  projection: ModelContextProjection,
  messages: readonly ReferencedTranscriptMessage[]
): ConversationTurn[] {
  validateProjection(projection, messages);
  const byId = new Map(messages.map((message) => [message.eventId, message]));
  const turns: ConversationTurn[] = projection.segments.flatMap((segment): ConversationTurn[] =>
    segment.kind === "inline" && segment.segmentKind === "knowledge"
      ? [{ role: "user", text: segment.text, raw: true }]
      : []
  );
  if (projection.summary?.trim()) {
    turns.push({ role: "assistant", text: `[Compacted context]\n${projection.summary.trim()}` });
  }
  for (const segment of projection.segments) {
    if (segment.kind === "transcript_ref") {
      const message = byId.get(segment.eventId)!;
      turns.push({ role: message.role, text: message.text });
    } else if (segment.segmentKind === "turn" && segment.role) {
      turns.push({ role: segment.role, text: segment.text });
    } else if (segment.segmentKind === "current_user") {
      turns.push({ role: "user", text: segment.text });
    }
  }
  const activeTurnSegments = projection.segments.filter(
    (segment): segment is InlineProjectionSegment =>
      segment.kind === "inline" &&
      segment.segmentKind !== "turn" &&
      segment.segmentKind !== "current_user" &&
      segment.segmentKind !== "knowledge"
  );
  if (activeTurnSegments.length > 0) {
    turns.push({
      role: "user",
      text: `${RETAINED_CONTINUATION_PREFIX}${activeTurnSegments.map((segment) => segment.text).join("\n\n")}`,
    });
  }
  return turns;
}

export function isRetainedContinuationTurn(turn: ConversationTurn | undefined): boolean {
  return turn?.role === "user" && turn.text.startsWith(RETAINED_CONTINUATION_PREFIX);
}

export function isRetainedRuntimeContextTurn(turn: ConversationTurn): boolean {
  return turn.raw === true || isRetainedContinuationTurn(turn);
}

export function conversationTurnsToProjection(turns: readonly ConversationTurn[]): ModelContextProjection {
  return {
    version: 1,
    segments: turns.map((turn) =>
      turn.raw
        ? { kind: "inline", segmentKind: "knowledge", text: turn.text }
        : { kind: "inline", segmentKind: "turn", role: turn.role, text: turn.text }
    ),
  };
}
