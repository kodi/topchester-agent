import { isKeyRelease, isKeyRepeat, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { TopchesterAgentRuntime, type AgentRuntime } from "../agent/runtime.js";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { type SessionEventPayload } from "../session/events.js";
import { createSession, type SessionHandle } from "../session/store.js";
import { BusyIndicator } from "./busy.js";
import { ChatLayout } from "./layout.js";
import { type ChatMessage, systemMessage } from "./messages.js";
import { renderRuntimeEvent } from "./runtime-events.js";
import { getFolderName, getModelLabel, getStartupThreadMessages, renderStaticLayout } from "./status.js";
import { enterAlternateScreen, exitAlternateScreen } from "./terminal.js";

export interface TuiShell {
  render(): Promise<void>;
}

export interface TuiShellOptions {
  session?: SessionHandle;
  initialMessages?: ChatMessage[];
}

export class TopchesterTuiShell implements TuiShell {
  private readonly runtime: AgentRuntime;
  private session: SessionHandle | undefined;

  constructor(
    private readonly context: AppContext,
    runtime?: AgentRuntime,
    private readonly options: TuiShellOptions = {}
  ) {
    this.runtime = runtime ?? new TopchesterAgentRuntime(context);
    this.session = options.session;
  }

  async render(): Promise<void> {
    const startedAt = Date.now();
    const session = this.options.session ?? (await createSession(this.context.workspaceRoot));
    this.session = session;
    const isResumed = this.options.session !== undefined;

    const messages = this.options.initialMessages ?? getStartupThreadMessages(this.context);
    if (!isResumed) {
      await persistMessagesWithWarning(session, messages, messages);
    }
    const folderName = getFolderName(this.context.workspaceRoot);
    const modelLabel = getModelLabel(this.context);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(renderStaticLayout(messages, folderName, modelLabel));
      return;
    }

    const terminal = new ProcessTerminal();
    enterAlternateScreen(terminal);
    const tui = new TUI(terminal, true);
    let didExit = false;
    const exit = () => {
      if (didExit) {
        return;
      }

      didExit = true;
      tui.stop();
      exitAlternateScreen(terminal);
      printExitBanner(session.sessionId, Date.now() - startedAt);
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
      await this.applyRuntimeEvents(app, await this.runtime.checkAgent(abortController.signal));
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
      await this.applyRuntimeEvents(app, this.runtime.checkKnowledgeBase());
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
      await this.persistPayloadWithWarning(app, {
        kind: "message",
        role: "user",
        text: message,
      });
      await this.applyRuntimeEvents(
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
        await this.persistPayloadWithWarning(app, {
          kind: "status",
          status: "chat failed",
        });
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
      await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));
      await this.applyRuntimeEvents(
        app,
        await this.runtime.submitSlashCommand(command, (event) => {
          busy.setActivity(event.message);
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.addMessage(systemMessage(`Command failed: ${errorMessage}`));
      app.setStatus("command failed");
      await this.persistPayloadWithWarning(app, {
        kind: "status",
        status: "command failed",
      });
    } finally {
      busy.stop();
      tui.requestRender();
    }
  }

  private async applyRuntimeEvents(app: ChatLayout, events: AgentRuntimeEvent[]): Promise<void> {
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

      await this.persistPayloadWithWarning(app, runtimeEventToSessionPayload(event));
    }
  }

  private async persistPayloadWithWarning(app: ChatLayout, payload: SessionEventPayload | undefined): Promise<void> {
    if (!this.session || !payload) {
      return;
    }

    try {
      await this.session.append(payload);
    } catch (error) {
      app.addMessage(systemMessage(`Session save failed: ${formatPlainError(error)}`));
    }
  }
}

export async function persistMessagesWithWarning(
  session: SessionHandle,
  messages: ChatMessage[],
  warningTarget: ChatMessage[] = messages
): Promise<void> {
  for (const message of messages) {
    const payload = chatMessageToSessionPayload(message);
    if (!payload) {
      continue;
    }

    try {
      await session.append(payload);
    } catch (error) {
      warningTarget.push(systemMessage(`Session save failed: ${formatPlainError(error)}`));
      return;
    }
  }
}

export function chatMessageToSessionPayload(message: ChatMessage): SessionEventPayload | undefined {
  if (message.kind === "system" || message.kind === "user" || message.kind === "agent") {
    return {
      kind: "message",
      role: message.kind === "agent" ? "assistant" : message.kind,
      text: message.text,
      ...(message.meta === undefined ? {} : { meta: message.meta }),
    };
  }

  if (message.kind === "modal") {
    return {
      kind: "choice",
      tone: message.tone,
      title: message.title,
      ...(message.body === undefined ? {} : { body: message.body }),
      actions: message.actions,
    };
  }

  return undefined;
}

export function runtimeEventToSessionPayload(event: AgentRuntimeEvent): SessionEventPayload | undefined {
  switch (event.type) {
    case "message":
      return {
        kind: "message",
        role: event.role,
        text: event.text,
        ...(event.meta === undefined ? {} : { meta: event.meta }),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        label: event.label,
        call: event.call as unknown as Record<string, unknown>,
      };
    case "knowledge_status":
      return undefined;
    case "choice":
      return {
        kind: "choice",
        tone: event.tone,
        title: event.title,
        ...(event.body === undefined ? {} : { body: event.body }),
        actions: event.actions,
      };
    case "status":
      return {
        kind: "status",
        status: event.status,
      };
  }
}

export function slashCommandToSessionPayload(command: string): SessionEventPayload {
  return {
    kind: "message",
    role: "user",
    text: command,
    meta: { source: "slash_command", visibleOnly: true },
  };
}

function formatPlainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function printExitBanner(sessionId: string, durationMs: number): void {
  console.log("");
  console.log(`${ui.heading("session ended")} ${ui.label(`after ${formatDuration(durationMs)}`)}`);
  console.log(`${ui.label("To resume this session, run:")} ${ui.ok(`topchester --resume ${sessionId}`)}`);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  }

  return parts.join(" ");
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
