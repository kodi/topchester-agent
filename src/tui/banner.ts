import { color, type UiColorName } from "../cli/ui.js";

export const ASCII_BANNERS = [
  [
    "s5SSSSs. .s5SSSs.  .s5SSSs.  .s5SSSs.  .s    s.  .s5SSSs.  .s5SSSs.  .s5SSSSs. .s5SSSs.  .s5SSSs.      .s5SSSs.  s.",
    "   SSS          SS.       SS.       SS.       SS.       SS.       SS.    SSS          SS.       SS.           SS. SS.",
    "   S%S    sS    S%S sS    S%S sS    `:; sS    S%S sS    `:; sS    `:;    S%S    sS    `:; sS    S%S     sS    S%S S%S",
    "   S%S    SS    S%S SS    S%S SS        SS    S%S SS        SS           S%S    SS        SS    S%S     SS    S%S S%S",
    "   S%S    SS    S%S SS .sS::' SS        SSSs. S%S SSSs.     `:;;;;.      S%S    SSSs.     SS .sS;:'     SSSs. S%S S%S",
    "   S%S    SS    S%S SS        SS        SS    S%S SS              ;;.    S%S    SS        SS    ;,      SS    S%S S%S",
    "   `:;    SS    `:; SS        SS        SS    `:; SS              `:;    `:;    SS        SS    `:;     SS    `:; `:;",
    "   ;,.    SS    ;,. SS        SS    ;,. SS    ;,. SS    ;,. .,;   ;,.    ;,.    SS    ;,. SS    ;,.     SS    ;,. ;,.",
    "   ;:'    `:;;;;;:' `:        `:;;;;;:' :;    ;:' `:;;;;;:' `:;;;;;:'    ;:'    `:;;;;;:' `:    ;:'     :;    ;:' ;:'",
  ].join("\n"),
  [
    "___  __   __   __        ___  __  ___  ___  __            ",
    " |  /  \\ |__) /  ` |__| |__  /__`  |  |__  |__)     /\\  | ",
    " |  \\__/ |    \\__, |  | |___ .__/  |  |___ |  \\    /~~\\ | ",
  ].join("\n"),
  [
    " dMMMMMMP .aMMMb  dMMMMb  .aMMMb  dMP dMP dMMMMMP .dMMMb dMMMMMMP dMMMMMP dMMMMb         .aMMMb  dMP ",
    '   dMP   dMP"dMP dMP.dMP dMP"VMP dMP dMP dMP     dMP" VP   dMP   dMP     dMP.dMP        dMP"dMP amr  ',
    '  dMP   dMP dMP dMMMMP" dMP     dMMMMMP dMMMP    VMMMb    dMP   dMMMP   dMMMMK"        dMMMMMP dMP   ',
    ' dMP   dMP.aMP dMP     dMP.aMP dMP dMP dMP     dP .dMP   dMP   dMP     dMP"AMF        dMP dMP dMP    ',
    'dMP    VMMMP" dMP      VMMMP" dMP dMP dMMMMMP  VMMMP"   dMP   dMMMMMP dMP dMP        dMP dMP dMP     ',
  ].join("\n"),
  [
    "  __________  ____  ________  _____________________________     ___    ____",
    " /_  __/ __ \\/ __ \\/ ____/ / / / ____/ ___/_  __/ ____/ __ \\   /   |  /  _/",
    "  / / / / / / /_/ / /   / /_/ / __/  \\__ \\ / / / __/ / /_/ /  / /| |  / /  ",
    " / / / /_/ / ____/ /___/ __  / /___ ___/ // / / /___/ _, _/  / ___ |_/ /   ",
    "/_/  \\____/_/    \\____/_/ /_/_____//____//_/ /_____/_/ |_|  /_/  |_/___/   ",
  ].join("\n"),
  [
    "                                  d8b                                                             d8,",
    "   d8P                            ?88                        d8P                                 `8P ",
    "d888888P                           88b                    d888888P                                    ",
    "  ?88'   d8888b ?88,.d88b, d8888b  888888b  d8888b .d888b,  ?88'   d8888b  88bd88b     d888b8b    88b",
    "  88P   d8P' ?88`?88'  ?88d8P' `P  88P `?8bd8b_,dP ?8b,     88P   d8b_,dP  88P'  `    d8P' ?88    88P",
    "  88b   88b  d88  88b  d8P88b     d88   88P88b       `?8b   88b   88b     d88         88b  ,88b  d88 ",
    "  `?8b  `?8888P'  888888P'`?888P'd88'   88b`?888P'`?888P'   `?8b  `?888P'd88'         `?88P'`88bd88' ",
    "                  88P'                                                                               ",
    "                 d88                                                                                 ",
    "                 ?8P                                                                                 ",
  ].join("\n"),
  [
    " ______   ______     ______   ______     __  __     ______     ______     ______   ______     ______        ______     __    ",
    "/\\__  _\\ /\\  __ \\   /\\  == \\ /\\  ___\\   /\\ \\_\\ \\   /\\  ___\\   /\\  ___\\   /\\__  _\\ /\\  ___\\   /\\  == \\      /\\  __ \\   /\\ \\   ",
    "\\/_/\\ \\/ \\ \\ \\/\\ \\  \\ \\  _-/ \\ \\ \\____  \\ \\  __ \\  \\ \\  __\\   \\ \\___  \\  \\/_/\\ \\/ \\ \\  __\\   \\ \\  __<      \\ \\  __ \\  \\ \\ \\  ",
    "   \\ \\_\\  \\ \\_____\\  \\ \\_\\    \\ \\_____\\  \\ \\_\\ \\_\\  \\ \\_____\\  \\/\\_____\\    \\ \\_\\  \\ \\_____\\  \\ \\_\\ \\_\\     \\ \\_\\ \\_\\  \\ \\_\\ ",
    "    \\/_/   \\/_____/   \\/_/     \\/_____/   \\/_/\\/_/   \\/_____/   \\/_____/     \\/_/   \\/_____/   \\/_/ /_/      \\/_/\\/_/   \\/_/ ",
  ].join("\n"),
  [
    "━┏┛┏━┃┏━┃┏━┛┃ ┃┏━┛┏━┛━┏┛┏━┛┏━┃  ┏━┃┛",
    " ┃ ┃ ┃┏━┛┃  ┏━┃┏━┛━━┃ ┃ ┏━┛┏┏┛  ┏━┃┃",
    " ┛ ━━┛┛  ━━┛┛ ┛━━┛━━┛ ┛ ━━┛┛ ┛  ┛ ┛┛",
  ].join("\n"),
  [
    "╺┳╸┏━┓┏━┓┏━╸╻ ╻┏━╸┏━┓╺┳╸┏━╸┏━┓   ┏━┓╻",
    " ┃ ┃ ┃┣━┛┃  ┣━┫┣╸ ┗━┓ ┃ ┣╸ ┣┳┛   ┣━┫┃",
    " ╹ ┗━┛╹  ┗━╸╹ ╹┗━╸┗━┛ ╹ ┗━╸╹┗╸   ╹ ╹╹",
  ].join("\n"),
  [
    " ______                        __                      __                      ______  ______     ",
    "/\\__  _\\                      /\\ \\                    /\\ \\__                  /\\  _  \\/\\__  _\\    ",
    "\\/_/\\ \\/   ___   _____     ___\\ \\ \\___      __    ____\\ \\ ,_\\    __   _ __    \\ \\ \\L\\ \\/_/\\ \\/    ",
    "   \\ \\ \\  / __`\\/\\ '__`\\  /'___\\ \\  _ `\\  /'__`\\ /',__\\\\ \\ \\/  /'__`\\/\\`'__\\   \\ \\  __ \\ \\ \\ \\    ",
    "    \\ \\ \\/\\ \\L\\ \\ \\ \\L\\ \\/\\ \\__/\\ \\ \\ \\ \\/\\  __//\\__, `\\\\ \\ \\_/\\  __/\\ \\ \\/     \\ \\ \\/\\ \\ \\_\\ \\__ ",
    "     \\ \\_\\ \\____/\\ \\ ,__/\\ \\____\\\\ \\_\\ \\_\\ \\____\\/\\____/ \\ \\__\\ \\____\\\\ \\_\\      \\ \\_\\ \\_\\/\\_____\\",
    "      \\/_/\\/___/  \\ \\ \\/  \\/____/ \\/_/\\/_/\\/____/\\/___/   \\/__/\\/____/ \\/_/       \\/_/\\/_/\\/_____/",
    "                   \\ \\_\\                                                                          ",
    "                    \\/_/                                                                          ",
  ].join("\n"),
  [
    "_/_/_/_/_/                              _/                              _/                                _/_/    _/_/_/   ",
    "   _/      _/_/    _/_/_/      _/_/_/  _/_/_/      _/_/      _/_/_/  _/_/_/_/    _/_/    _/  _/_/      _/    _/    _/      ",
    "  _/    _/    _/  _/    _/  _/        _/    _/  _/_/_/_/  _/_/        _/      _/_/_/_/  _/_/          _/_/_/_/    _/       ",
    " _/    _/    _/  _/    _/  _/        _/    _/  _/            _/_/    _/      _/        _/            _/    _/    _/        ",
    "_/      _/_/    _/_/_/      _/_/_/  _/    _/    _/_/_/  _/_/_/        _/_/    _/_/_/  _/            _/    _/  _/_/_/       ",
    "               _/                                                                                                          ",
    "              _/                                                                                                           ",
  ].join("\n"),
  [
    "d888888P                             dP                           dP                         .d888888  dP ",
    "   88                                88                           88                        d8'    88  88 ",
    "   88    .d8888b.  88d888b. .d8888b. 88d888b. .d8888b. .d8888b. d8888P .d8888b. 88d888b.    88aaaaa88a 88 ",
    "   88    88'  `88  88'  `88 88'  `\"\" 88'  `88 88ooood8 Y8ooooo.   88   88ooood8 88'  `88    88     88  88 ",
    "   88    88.  .88  88.  .88 88.  ... 88    88 88.  ...       88   88   88.  ... 88          88     88  88 ",
    "   dP    `88888P'  88Y888P' `88888P' dP    dP `88888P' `88888P'   dP   `88888P' dP          88     88  dP ",
    "oooooooooooooooooo~88~oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "                   dP                                                                                     ",
  ].join("\n"),
  [
    " ____ ____ ____ ____ ____ ____ ____ ____ ____ ____ _________ ____ ____ ",
    "||T |||o |||p |||c |||h |||e |||s |||t |||e |||r |||       |||A |||I ||",
    "||__|||__|||__|||__|||__|||__|||__|||__|||__|||__|||_______|||__|||__||",
    "|/__\\|/__\\|/__\\|/__\\|/__\\|/__\\|/__\\|/__\\|/__\\|/__\\|/_______\\|/__\\|/__\\|",
  ].join("\n"),
  [
    "________                   ______             _____                 _______________",
    "___  __/______________________  /_______________  /_____________    ___    |___  _/",
    "__  /  _  __ \\__  __ \\  ___/_  __ \\  _ \\_  ___/  __/  _ \\_  ___/    __  /| |__  /  ",
    "_  /   / /_/ /_  /_/ / /__ _  / / /  __/(__  )/ /_ /  __/  /        _  ___ |_/ /   ",
    "/_/    \\____/_  .___/\\___/ /_/ /_/\\___//____/ \\__/ \\___//_/         /_/  |_/___/   ",
    "             /_/                                                                   ",
  ].join("\n"),
  [
    " @@@@@@@  @@@@@@  @@@@@@@   @@@@@@@ @@@  @@@ @@@@@@@@  @@@@@@ @@@@@@@ @@@@@@@@ @@@@@@@        @@@@@@  @@@",
    "   @@!   @@!  @@@ @@!  @@@ !@@      @@!  @@@ @@!      !@@       @@!   @@!      @@!  @@@      @@!  @@@ @@!",
    "   @!!   @!@  !@! @!@@!@!  !@!      @!@!@!@! @!!!:!    !@@!!    @!!   @!!!:!   @!@!!@!       @!@!@!@! !!@",
    "   !!:   !!:  !!! !!:      :!!      !!:  !!! !!:          !:!   !!:   !!:      !!: :!!       !!:  !!! !!:",
    "    :     : :. :   :        :: :: :  :   : : : :: ::: ::.: :     :    : :: :::  :   : :       :   : : :  ",
  ].join("\n"),
];

export const ASCII_BANNER_COLORS = ["purple", "blue", "yellow", "orange", "red", "green", "cyan"] as const;

export function getRandomAsciiBanner(banners = ASCII_BANNERS, random: () => number = Math.random): string | undefined {
  if (banners.length === 0) {
    return undefined;
  }

  const index = Math.floor(random() * banners.length) % banners.length;

  return banners[index];
}

export function getRandomAsciiBannerColor(
  colors: readonly UiColorName[] = ASCII_BANNER_COLORS,
  random: () => number = Math.random
): UiColorName | undefined {
  if (colors.length === 0) {
    return undefined;
  }

  const index = Math.floor(random() * colors.length) % colors.length;

  return colors[index];
}

export function colorAsciiBanner(banner: string, random: () => number = Math.random): string {
  const colorName = getRandomAsciiBannerColor(ASCII_BANNER_COLORS, random);

  return colorName
    ? banner
        .split("\n")
        .map((line) => color(line, colorName))
        .join("\n")
    : banner;
}
