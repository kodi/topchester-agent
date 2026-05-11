import { type Terminal } from "@earendil-works/pi-tui";

export function enterAlternateScreen(terminal: Pick<Terminal, "write" | "clearScreen">): void {
  terminal.write("\u001b[?1049h");
  terminal.clearScreen();
}

export function exitAlternateScreen(terminal: Pick<Terminal, "write">): void {
  terminal.write("\u001b[?1049l");
}
