import { type ConversationTurn } from "../conversation.js";
import { estimateTextTokens } from "./estimate.js";
import { conversationTurnsToProjection, type ModelContextProjection } from "./projection.js";
import { type PromptSegment } from "./prompt.js";

export interface PruningResult {
  segments: PromptSegment[];
  beforeTokens: number;
  afterTokens: number;
  savingsPercent: number;
  prunedAssociations: string[];
}

export function prunePromptSegments(
  segments: readonly PromptSegment[],
  options: { targetTokens: number; keepRecentTokens: number }
): PruningResult {
  const beforeTokens = segments.reduce((total, segment) => total + estimateTextTokens(segment.text), 0);
  let current = beforeTokens;
  let protectedTail = 0;
  const output = [...segments];
  const prunedAssociations: string[] = [];
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const segment = output[index]!;
    const tokens = estimateTextTokens(segment.text);
    if (protectedTail < options.keepRecentTokens && tokens <= options.keepRecentTokens - protectedTail) {
      protectedTail += tokens;
      continue;
    }
    if (current <= options.targetTokens || segment.retention !== "replaceable") continue;
    const stub = formatPrunedStub(segment);
    current -= Math.max(0, tokens - estimateTextTokens(stub));
    output[index] = { ...segment, text: stub, retention: "recent" };
    if (segment.associationId) prunedAssociations.push(segment.associationId);
  }
  return {
    segments: output,
    beforeTokens,
    afterTokens: current,
    savingsPercent: beforeTokens === 0 ? 0 : Math.round(((beforeTokens - current) / beforeTokens) * 100),
    prunedAssociations,
  };
}

export function compactConversationDeterministically(
  turns: readonly ConversationTurn[],
  options: { keepRecentTokens: number; focus?: string }
): { projection: ModelContextProjection; beforeTokens: number; afterTokens: number } {
  const beforeTokens = estimateTextTokens(turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n\n"));
  if (turns.length <= 4) {
    return { projection: conversationTurnsToProjection(turns), beforeTokens, afterTokens: beforeTokens };
  }
  let retainedTokens = 0;
  let boundary = turns.length;
  while (boundary > 2 && retainedTokens < options.keepRecentTokens) {
    boundary -= 1;
    retainedTokens += estimateTextTokens(turns[boundary]!.text);
  }
  boundary = Math.min(boundary, turns.length - 4);
  const older = turns.slice(0, boundary);
  const recent = turns.slice(boundary);
  const summary = [
    "Goal and prior context retained by deterministic compaction:",
    ...(options.focus?.trim() ? [`Focus: ${options.focus.trim()}`] : []),
    ...older.map((turn) => `- ${turn.role}: ${compactLine(turn.text)}`),
  ].join("\n");
  const projection = conversationTurnsToProjection(recent);
  projection.summary = summary;
  const afterTokens = estimateTextTokens(
    `${summary}\n\n${recent.map((turn) => `${turn.role}: ${turn.text}`).join("\n\n")}`
  );
  return { projection, beforeTokens, afterTokens };
}

export function isEffectiveCompaction(beforeTokens: number, afterTokens: number): boolean {
  return beforeTokens > 0 && (beforeTokens - afterTokens) / beforeTokens >= 0.15;
}

function formatPrunedStub(segment: PromptSegment): string {
  const name = segment.metadata?.toolName ?? "tool";
  const subject = segment.metadata?.path ?? segment.metadata?.command ?? segment.associationId ?? "result";
  const state = segment.metadata?.error ? "error retained" : "completed; output pruned";
  const association = segment.associationId ? `; association ${segment.associationId}` : "";
  return `[${name} ${subject}${association}: ${state}]`;
}

function compactLine(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= 800 ? normalized : `${normalized.slice(0, 797)}...`;
}
