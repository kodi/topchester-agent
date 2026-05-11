import { matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { TopchesterAgentRuntime, type AgentRuntime } from "../agent/runtime.js";
import { type AppContext } from "../app/context.js";
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

    let exitPending = false;
    tui.addChild(app);
    tui.setFocus(app);
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        if (exitPending) {
          exit();
          process.exit(0);
        }

        exitPending = true;
        app.setEphemeralLine("press Ctrl-C again to exit.");
        tui.requestRender();
        return { consume: true };
      }

      if (exitPending) {
        exitPending = false;
        app.setEphemeralLine(undefined);
        tui.requestRender();
      }

      return undefined;
    });
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
    try {
      this.applyRuntimeEvents(app, await this.runtime.submitSlashCommand(command));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.addMessage(systemMessage(`Command failed: ${errorMessage}`));
      app.setStatus("command failed");
    } finally {
      tui.requestRender();
    }
  }

  private applyRuntimeEvents(app: ChatLayout, events: AgentRuntimeEvent[]): void {
    for (const event of events) {
      if (event.type === "status") {
        app.setStatus(event.status);
      }

      for (const message of renderRuntimeEvent(event)) {
        app.addMessage(message);
      }
    }
  }
}
