import { describe, expect, it } from "vite-plus/test";
import { TuiViewStore } from "../src/chat/controller-state.js";
import { ComposerState } from "../src/tui/opentui/composer-state.js";
import { formatQueuedFollowUpPreview } from "../src/tui/opentui/live-footer.js";
import { getListWindowStart } from "../src/tui/opentui/list-window.js";
import { isLightTerminalPalette, resolveTopchesterTheme } from "../src/tui/opentui/theme.js";

describe("OpenTUI local UI state", () => {
  it("publishes epoch-scoped incremental transcript changes without inspecting history on footer updates", () => {
    const profile = { viewPublications: 0, transcriptRecordsInspected: 0 };
    const view = new TuiViewStore({
      sessionId: "first",
      workspaceLabel: "fixture",
      transcript: Array.from({ length: 1000 }, (_, index) => ({
        kind: "system" as const,
        persistence: "session" as const,
        text: `entry ${index}`,
      })),
      modelLabel: "fixture",
      profile,
    });
    const initial = view.getSnapshot();

    expect(initial.transcriptRecords[0]).toMatchObject({ sessionEpoch: 0, id: 0 });
    expect(initial.transcriptRecords.at(-1)).toMatchObject({ sessionEpoch: 0, id: 999 });
    expect(initial.transcriptChange).toMatchObject({ kind: "reset", sessionEpoch: 0 });

    view.setStatus("typing");
    const footerOnly = view.getSnapshot();
    expect(footerOnly.transcript).toBe(initial.transcript);
    expect(footerOnly.transcriptRecords).toBe(initial.transcriptRecords);
    expect(footerOnly.transcriptChange).toEqual({ kind: "none", sessionEpoch: 0 });
    expect(profile.transcriptRecordsInspected).toBe(0);

    view.addEntry({
      kind: "choice",
      persistence: "session",
      tone: "info",
      title: "Continue?",
      actions: [{ label: "Yes" }],
    });
    expect(view.getSnapshot().transcriptChange).toMatchObject({
      kind: "append",
      sessionEpoch: 0,
      records: [expect.objectContaining({ id: 1000, sessionEpoch: 0 })],
    });
    view.removeActiveChoice();
    expect(view.getSnapshot().transcriptChange).toEqual({ kind: "remove", sessionEpoch: 0, recordIds: [1000] });

    view.addEntry({ kind: "assistant", persistence: "session", text: "stable" });
    expect(view.getSnapshot().transcriptChange).toMatchObject({
      kind: "append",
      records: [expect.objectContaining({ id: 1001, sessionEpoch: 0 })],
    });

    view.reset({
      sessionId: "second",
      transcript: [{ kind: "user", persistence: "session", text: "restored" }],
      modelLabel: "fixture",
    });
    expect(view.getSnapshot()).toMatchObject({
      sessionEpoch: 1,
      transcriptChange: {
        kind: "reset",
        sessionEpoch: 1,
        records: [expect.objectContaining({ id: 0, sessionEpoch: 1 })],
      },
    });
  });

  it("previews large pastes and expands them exactly at submission", () => {
    const state = new ComposerState();
    const pasted = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\r\n");

    const marker = state.preparePaste(pasted);

    expect(marker).toBe("[Pasted #1 7 lines 48 chars]");
    expect(state.expandSubmission(`before ${marker} after`)).toBe(`before ${pasted.replaceAll("\r\n", "\n")} after`);
    expect(state.expandSubmission(marker)).toBe(marker);
  });

  it("inserts small normalized pastes without a preview", () => {
    const state = new ComposerState();

    expect(state.preparePaste("one\rtwo\tthree")).toBe("one\ntwo    three");
    expect(state.preparePaste("  \n  ")).toBe("");
  });

  it("preserves and restores the active draft while browsing history", () => {
    const state = new ComposerState();
    state.recordSubmission("first");
    state.recordSubmission("second");

    expect(state.previousHistory("unfinished")).toBe("second");
    expect(state.previousHistory("second")).toBe("first");
    expect(state.nextHistory()).toBe("second");
    expect(state.nextHistory()).toBe("unfinished");
  });

  it("keeps selected items inside bounded list windows", () => {
    expect(getListWindowStart(20, 0, 6)).toBe(0);
    expect(getListWindowStart(20, 10, 6)).toBe(7);
    expect(getListWindowStart(20, 19, 6)).toBe(14);
    expect(getListWindowStart(3, 2, 6)).toBe(0);
  });

  it("provides distinct dark, light, and no-color semantic themes", () => {
    const dark = resolveTopchesterTheme();
    const light = resolveTopchesterTheme({ light: true });
    const noColor = resolveTopchesterTheme({ noColor: true });

    expect(dark.background).not.toBe(light.background);
    expect(dark.focus).toBe(dark.accent);
    expect(light.focus).toBe(light.accent);
    expect(noColor.focus).toBe("#ffffff");
    expect(noColor.success).toBe(noColor.error);
  });

  it("detects light terminal palettes from the reported background", () => {
    const palette = (background: string) =>
      ({ defaultBackground: background }) as Parameters<typeof isLightTerminalPalette>[0];

    expect(isLightTerminalPalette(palette("#ffffff"))).toBe(true);
    expect(isLightTerminalPalette(palette("#101218"))).toBe(false);
    expect(isLightTerminalPalette(palette("unknown"))).toBe(false);
  });

  it("formats queued follow-ups as one width-bounded line", () => {
    expect(formatQueuedFollowUpPreview("Keep this visible", 40)).toBe("[QUEUED] Keep this visible");
    expect(formatQueuedFollowUpPreview("first line\nsecond   line", 80)).toBe("[QUEUED] first line second line");
    expect(formatQueuedFollowUpPreview("This message must be shortened", 24)).toBe("[QUEUED] This message…");
    expect(formatQueuedFollowUpPreview("anything", 8)).toBe("[QUEUED]");
  });
});
