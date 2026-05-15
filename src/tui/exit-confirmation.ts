import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

export interface ExitConfirmationOptions {
  setNoticeLine(line: string | undefined): void;
  requestRender(): void;
  exit(): void;
  timeoutMs?: number;
}

export function createExitConfirmationInputListener(options: ExitConfirmationOptions) {
  const timeoutMs = options.timeoutMs ?? 2500;
  let exitPending = false;
  let exitPendingUntil = 0;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const clearExitNotice = () => {
    clearTimer = undefined;
    exitPending = false;
    exitPendingUntil = 0;
    options.setNoticeLine(undefined);
    options.requestRender();
  };

  return (data: string) => {
    if ((isKeyRelease(data) || isKeyRepeat(data)) && matchesKey(data, "ctrl+c")) {
      return { consume: true };
    }

    if (!matchesKey(data, "ctrl+c")) {
      return undefined;
    }

    if (exitPending && Date.now() <= exitPendingUntil) {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = undefined;
      }

      options.exit();
      return { consume: true };
    }

    exitPending = true;
    exitPendingUntil = Date.now() + timeoutMs;
    options.setNoticeLine("press Ctrl-C again to exit.");
    options.requestRender();

    if (clearTimer) {
      clearTimeout(clearTimer);
    }

    clearTimer = setTimeout(clearExitNotice, timeoutMs);
    clearTimer.unref?.();

    return { consume: true };
  };
}
