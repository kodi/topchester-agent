export interface TopchesterTheme {
  background: string;
  text: string;
  muted: string;
  emphasis: string;
  surface: string;
  overlay: string;
  selection: string;
  accent: string;
  focus: string;
  info: string;
  success: string;
  warning: string;
  error: string;
  diffAdded: string;
  diffRemoved: string;
}

export function resolveTopchesterTheme(options: { light?: boolean; noColor?: boolean } = {}): TopchesterTheme {
  if (options.noColor) {
    return {
      background: "#000000",
      text: "#d0d0d0",
      muted: "#a0a0a0",
      emphasis: "#ffffff",
      surface: "#000000",
      overlay: "#000000",
      selection: "#404040",
      accent: "#ffffff",
      focus: "#ffffff",
      info: "#ffffff",
      success: "#ffffff",
      warning: "#ffffff",
      error: "#ffffff",
      diffAdded: "#202020",
      diffRemoved: "#202020",
    };
  }

  if (options.light) {
    return {
      background: "#ffffff",
      text: "#24292f",
      muted: "#57606a",
      emphasis: "#0b0f14",
      surface: "#f6f8fa",
      overlay: "#ffffff",
      selection: "#dbeafe",
      accent: "#0969da",
      focus: "#0969da",
      info: "#0969da",
      success: "#1a7f37",
      warning: "#9a6700",
      error: "#cf222e",
      diffAdded: "#dafbe1",
      diffRemoved: "#ffebe9",
    };
  }

  return {
    background: "#16181d",
    text: "#d8dee9",
    muted: "#7f8c9d",
    emphasis: "#ffffff",
    surface: "#20242c",
    overlay: "#2a303b",
    selection: "#34445c",
    accent: "#7aa2f7",
    focus: "#7aa2f7",
    info: "#7dcfff",
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    diffAdded: "#243b2f",
    diffRemoved: "#422b32",
  };
}

export async function resolveTopchesterThemeForRenderer(
  renderer: CliRenderer,
  options: { noColor?: boolean } = {}
): Promise<TopchesterTheme> {
  if (options.noColor) {
    return resolveTopchesterTheme({ noColor: true });
  }

  try {
    const palette = await renderer.getPalette({ timeout: 120, size: 16 });
    return resolveTopchesterTheme({ light: isLightTerminalPalette(palette) });
  } catch {
    return resolveTopchesterTheme({ light: inferLightColorScheme(process.env.COLORFGBG) });
  }
}

export function createTopchesterSyntaxStyle(theme: TopchesterTheme): SyntaxStyle {
  const tokens: ThemeTokenStyle[] = [
    { scope: ["comment"], style: { foreground: theme.muted, italic: true } },
    { scope: ["string"], style: { foreground: theme.success } },
    { scope: ["keyword", "storage", "operator"], style: { foreground: theme.accent, bold: true } },
    { scope: ["function", "method"], style: { foreground: theme.info } },
    { scope: ["type", "class", "interface"], style: { foreground: theme.warning } },
    { scope: ["constant", "number", "boolean"], style: { foreground: theme.warning } },
    { scope: ["variable", "property"], style: { foreground: theme.text } },
    { scope: ["punctuation"], style: { foreground: theme.muted } },
    {
      scope: [
        "markup.heading",
        "markup.heading.1",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
      ],
      style: { foreground: theme.accent, bold: true },
    },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.emphasis, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.text, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.accent } },
    { scope: ["markup.quote"], style: { foreground: theme.muted, italic: true } },
    { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: { foreground: theme.success } },
    {
      scope: ["markup.link", "markup.link.label", "markup.link.url"],
      style: { foreground: theme.info, underline: true },
    },
    { scope: ["conceal"], style: { foreground: theme.muted } },
  ];
  return SyntaxStyle.fromTheme(tokens);
}

export function isLightTerminalPalette(colors: TerminalColors): boolean {
  const background = colors.defaultBackground;
  if (!background) {
    return false;
  }
  const hex = background.replace(/^#/u, "");
  if (!/^[\da-f]{6}$/iu.test(hex)) {
    return false;
  }
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return 0.299 * red + 0.587 * green + 0.114 * blue > 0.5;
}

function inferLightColorScheme(colorFgBg: string | undefined): boolean {
  const background = colorFgBg?.split(";").at(-1);
  if (!background || !/^\d+$/u.test(background)) {
    return false;
  }
  const index = Number(background);
  return index === 7 || index === 15 || index >= 252;
}
import { SyntaxStyle, type CliRenderer, type TerminalColors, type ThemeTokenStyle } from "@opentui/core";
