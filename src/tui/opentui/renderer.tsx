/** @jsxImportSource @opentui/solid */

import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { type AgentRuntime } from "../../agent/runtime/index.js";
import { type AppContext } from "../../app/context.js";
import { TopchesterTuiController, type TuiControllerOptions } from "../../chat/controller.js";
import { renderStaticView } from "../../chat/static-view.js";
import { printExitBanner } from "../../cli/exit-banner.js";
import { createFileMentionProvider } from "../file-mention-provider.js";
import { getRandomAsciiBanner } from "../banner.js";
import { TopchesterApp } from "./app.js";
import { createTopchesterSyntaxStyle, resolveTopchesterThemeForRenderer } from "./theme.js";

export interface RunOpenTuiOptions extends TuiControllerOptions {
  rendererFactory?: () => Promise<CliRenderer>;
}

export async function runOpenTui(
  context: AppContext,
  runtime?: AgentRuntime,
  options: RunOpenTuiOptions = {}
): Promise<void> {
  const banner = options.banner ?? getRandomAsciiBanner();
  const controller = await TopchesterTuiController.create(context, runtime, {
    ...options,
    ...(banner === undefined ? {} : { banner }),
  });

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    try {
      console.log(renderStaticView(controller.getSnapshot()));
    } finally {
      await controller.dispose();
    }
    return;
  }

  let rendererToDestroy: CliRenderer | undefined;
  let syntaxStyleToDestroy: ReturnType<typeof createTopchesterSyntaxStyle> | undefined;
  let finish: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  let finished = false;
  let interruptCount = 0;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    fail = (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    };
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const interrupt = () => {
    if (controller.cancel()) {
      interruptCount = 0;
      if (interruptTimer) clearTimeout(interruptTimer);
      interruptTimer = undefined;
      controller.setNoticeLine(undefined);
      return;
    }
    interruptCount += 1;
    if (interruptCount === 1) {
      controller.setNoticeLine("press Ctrl-C again to exit.");
      if (interruptTimer) clearTimeout(interruptTimer);
      interruptTimer = setTimeout(() => {
        interruptCount = 0;
        controller.setNoticeLine(undefined);
      }, 2500);
      interruptTimer.unref?.();
      return;
    }
    finish();
  };
  try {
    const renderer = await (options.rendererFactory?.() ?? createProductionRenderer());
    rendererToDestroy = renderer;
    const theme = await resolveTopchesterThemeForRenderer(renderer, { noColor: process.env.NO_COLOR !== undefined });
    renderer.setBackgroundColor(theme.background);
    const syntaxStyle = createTopchesterSyntaxStyle(theme);
    syntaxStyleToDestroy = syntaxStyle;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = signal === "SIGINT" ? interrupt : () => finish();
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    await render(
      () => (
        <TopchesterApp
          controller={controller}
          initialSnapshot={controller.getSnapshot()}
          theme={theme}
          syntaxStyle={syntaxStyle}
          renderer={renderer}
          mentionProvider={createFileMentionProvider({
            workspaceRoot: context.workspaceRoot,
            logger: context.logger,
            onUpdate: () => renderer.requestRender(),
          })}
          onRenderError={fail}
          onInterrupt={interrupt}
        />
      ),
      renderer
    );
    controller.start();
    await done;
  } finally {
    if (interruptTimer) clearTimeout(interruptTimer);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    await controller.dispose();
    rendererToDestroy?.destroy();
    syntaxStyleToDestroy?.destroy();
  }

  const session = controller.getSessionInfo();
  printExitBanner(session.sessionId, session.durationMs);
}

export function createProductionRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    screenMode: "split-footer",
    footerHeight: 16,
    externalOutputMode: "capture-stdout",
    clearOnShutdown: false,
    useMouse: false,
    exitOnCtrlC: false,
    exitSignals: [],
    consoleMode: "disabled",
    targetFps: 30,
  });
}
