import { describe, expect, it } from "vite-plus/test";
import { ComposerState } from "../src/tui/opentui/composer-state.js";
import { getListWindowStart } from "../src/tui/opentui/list-window.js";
import { isLightTerminalPalette, resolveTopchesterTheme } from "../src/tui/opentui/theme.js";

describe("OpenTUI local UI state", () => {
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
});
