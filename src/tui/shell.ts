import { isKeyRelease, isKeyRepeat, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { TopchesterAgentRuntime, type AgentRuntime } from "../agent/runtime.js";
import { type AppContext } from "../app/context.js";
import { ensureSessionStorage } from "../session/store.js";
import { BusyIndicator } from "./busy.js";
import { ChatLayout } from "./layout.js";
import { systemMessage } from "./messages.js";
import { renderRuntimeEvent } from "./runtime-events.js";
import { getFolderName, getModelLabel, getStartupThreadMessages, renderStaticLayout } from "./status.js";
import { enterAlternateScreen, exitAlternateScreen } from "./terminal.js";

export interface TuiShell {
  render(): Promise<void>;
}

export class TopchesterTuiShell implements TuiShell {
  private readonly runtime: AgentRuntime;

  constructor(
    private readonly context: AppContext,
    runtime?: AgentRuntime
  ) {
    this.runtime = runtime ?? new TopchesterAgentRuntime(context);
  }

  async render(): Promise<void> {
    await ensureSessionStorage(this.context.workspaceRoot);

    const messages = getStartupThreadMessages(this.context);
    const folderName = getFolderName(this.context.workspaceRoot);
    const modelLabel = getModelLabel(this.context);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(renderStaticLayout(messages, folderName, modelLabel));
      return;
    }

    const terminal = new ProcessTerminal();
    enterAlternateScreen(terminal);
    const tui = new TUI(terminal, true);
    const exit = () => {
      tui.stop();
      exitAlternateScreen(terminal);
    };
    const app = new ChatLayout(terminal, messages, folderName, modelLabel, () => {
      exit();
      process.exit(0);
    });
    app.setSubmitMessage((message) => {
      void this.submitChatMessage(app, tui, message);
    });
    app.setSubmitCommand((command) => {
      void this.submitSlashCommand(app, tui, command);
    });

    tui.addChild(app);
    tui.setFocus(app);
    tui.addInputListener(
      createExitConfirmationInputListener({
        setNoticeLine: (line) => {
          app.setNoticeLine(line);
        },
        requestRender: () => {
          tui.requestRender();
        },
        exit: () => {
          exit();
          process.exit(0);
        },
      })
    );
    tui.start();
    void this.checkAgent(app, tui);
  }

  private async checkAgent(app: ChatLayout, tui: TUI): Promise<void> {
    const busy = new BusyIndicator(app, tui, {
      status: "checking agent",
      promptHint: "press Esc to stop",
      activities: ["Checking model config...", "Calling agent.fast...", "Waiting for model..."],
    });
    const abortController = new AbortController();
    let cancelled = false;

    app.setCancelPending(() => {
      cancelled = true;
      abortController.abort();
    });
    busy.start();
    tui.requestRender();

    try {
      this.applyRuntimeEvents(app, await this.runtime.checkAgent(abortController.signal));
    } catch (error) {
      if (cancelled) {
        app.addMessage(systemMessage("Agent check stopped."));
        app.setStatus("ready");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        app.addMessage(systemMessage(`Agent check failed: ${message}`));
        app.setStatus("agent check failed");
      }
    } finally {
      app.setCancelPending(undefined);
      busy.stop();
    }

    if (app.isReady()) {
      this.applyRuntimeEvents(app, this.runtime.checkKnowledgeBase());
    }

    tui.requestRender();
  }

  private async submitChatMessage(app: ChatLayout, tui: TUI, message: string): Promise<void> {
    const busy = new BusyIndicator(app, tui, {
      status: "thinking",
      promptHint: "press Esc to stop",
      activities: ["Thinking...", "Calling model...", "Writing response..."],
    });
    const abortController = new AbortController();
    let cancelled = false;

    app.setCancelPending(() => {
      cancelled = true;
      abortController.abort();
    });
    busy.start();
    tui.requestRender();

    try {
      this.applyRuntimeEvents(
        app,
        await this.runtime.submitMessage(app.getConversationTurns(), message, abortController.signal)
      );
    } catch (error) {
      if (cancelled) {
        app.addMessage(systemMessage("Response stopped."));
        app.setStatus("ready");
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        app.addMessage(systemMessage(`Chat failed: ${errorMessage}`));
        app.setStatus("chat failed");
      }
    } finally {
      app.setCancelPending(undefined);
      busy.stop();
      tui.requestRender();
    }
  }

  private async submitSlashCommand(app: ChatLayout, tui: TUI, command: string): Promise<void> {
    const busy = new BusyIndicator(app, tui, {
      status: "running command",
      promptHint: "working...",
      activities: getSlashCommandActivities(command),
      activityEveryMs: 5000,
    });

    busy.start();
    tui.requestRender();

    try {
      this.applyRuntimeEvents(
        app,
        await this.runtime.submitSlashCommand(command, (event) => {
          busy.setActivity(event.message);
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.addMessage(systemMessage(`Command failed: ${errorMessage}`));
      app.setStatus("command failed");
    } finally {
      busy.stop();
      tui.requestRender();
    }
  }

  private applyRuntimeEvents(app: ChatLayout, events: AgentRuntimeEvent[]): void {
    for (const event of events) {
      if (event.type === "status") {
        app.setStatus(event.status);
      }

      if (event.type === "knowledge_status") {
        app.setKnowledgeStatus(event.status);
      }

      for (const message of renderRuntimeEvent(event)) {
        app.addMessage(message);
      }
    }
  }
}

function getSlashCommandActivities(command: string): string[] {
  if (command.startsWith("/kb compile")) {
    return [
      "Checking project knowledge folders...",
      "Reading .gitignore files...",
      "Listing project files...",
      "Queueing L1 work...",
    ];
  }

  if (command.startsWith("/kb reset")) {
    return ["Checking project knowledge paths...", "Removing knowledge folder...", "Removing local cache folder..."];
  }

  return ["Running command...", "Preparing project knowledge folders...", "Writing project knowledge folders..."];
}

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
