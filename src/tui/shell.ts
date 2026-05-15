import { isKeyRelease, isKeyRepeat, matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { formatTaskPlanNotice, type TaskPlanState } from "../agent/task-plan.js";
import {
  TopchesterAgentRuntime,
  type AgentRuntime,
  type RunCommandApprovalDecision,
  type RunCommandApprovalRequest,
} from "../agent/runtime.js";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { addProjectCommandAllowExactRule } from "../config/index.js";
import { type ModelReasoningEvent, type ModelReasoningSink } from "../model/index.js";
import { type SessionEventPayload } from "../session/events.js";
import { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";
import { createSession, type SessionHandle } from "../session/store.js";
import { BusyIndicator, ReasoningTailBuffer } from "./busy.js";
import { ChatLayout } from "./layout.js";
import { type ChatMessage, systemMessage, thinkingMessage } from "./messages.js";
import { renderRuntimeEvent } from "./runtime-events.js";
import { getFolderName, getModelLabel, getStartupThreadMessages, renderStaticLayout } from "./status.js";

export { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";

export interface TuiShell {
  render(): Promise<void>;
}

export interface TuiShellOptions {
  session?: SessionHandle;
  initialMessages?: ChatMessage[];
  initialTaskPlan?: TaskPlanState;
}

export class TopchesterTuiShell implements TuiShell {
  private readonly runtime: AgentRuntime;
  private session: SessionHandle | undefined;
  private sessionStartedAt = Date.now();
  private taskPlanNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: AppContext,
    runtime?: AgentRuntime,
    private readonly options: TuiShellOptions = {}
  ) {
    this.runtime = runtime ?? new TopchesterAgentRuntime(context);
    this.session = options.session;
  }

  async render(): Promise<void> {
    this.sessionStartedAt = Date.now();
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
      console.log(renderStaticLayout(messages, folderName, modelLabel, this.options.initialTaskPlan));
      return;
    }

    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);
    let didExit = false;
    const exit = () => {
      if (didExit) {
        return;
      }

      didExit = true;
      tui.stop();
      this.printExitBannerForCurrentSession(session);
    };
    const app = new ChatLayout(terminal, messages, folderName, modelLabel, {
      transcriptMode: "inline",
      exitAgent: () => {
        exit();
        process.exit(0);
      },
    });
    app.setTaskPlan(this.options.initialTaskPlan);
    app.setSubmitMessage((message) => {
      this.startBackgroundTask(app, tui, "Chat", () => this.submitChatMessage(app, tui, message));
    });
    app.setSubmitCommand((command) => {
      this.startBackgroundTask(app, tui, "Command", () => this.submitSlashCommand(app, tui, command));
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
    this.startBackgroundTask(app, tui, "Agent check", () => this.checkAgent(app, tui));
  }

  private startBackgroundTask(app: ChatLayout, tui: TUI, label: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      app.addMessage(systemMessage(`${label} failed: ${formatPlainError(error)}`));
      app.setStatus("ready");
      app.setCancelPending(undefined);
      tui.requestRender();
    });
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
      await this.applyRuntimeEvents(app, await this.runtime.checkAgent(abortController.signal), tui);
    } catch (error) {
      if (cancelled) {
        app.addMessage(systemMessage("Agent check stopped."));
        app.setStatus("ready");
      } else {
        const message = formatPlainError(error);
        app.addMessage(systemMessage(`Agent check failed: ${message}`));
        app.setStatus("agent check failed");
      }
    } finally {
      app.setCancelPending(undefined);
      busy.stop();
    }

    if (app.isReady()) {
      await this.applyRuntimeEvents(app, await this.runtime.checkKnowledgeBase(), tui);
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
    const reasoningDisplay = isStreamReasoningEnabledByEnv() ? createBusyReasoningSink(busy) : undefined;
    let cancelled = false;

    app.setCancelPending(() => {
      cancelled = true;
      abortController.abort();
    });
    busy.start();
    tui.requestRender();

    try {
      await this.clearTaskPlanForNewTurn(app);
      await this.persistPayloadWithWarning(app, {
        kind: "message",
        role: "user",
        text: message,
      });
      for await (const event of this.runtime.submitMessageStream(
        app.getConversationTurns(),
        message,
        abortController.signal,
        {
          onReasoning: reasoningDisplay?.sink,
          session: this.session,
          requestRunCommandApproval: (request) =>
            this.requestRunCommandApproval(app, tui, busy, request, abortController.signal),
        }
      )) {
        if (event.type === "message" && event.role === "assistant") {
          reasoningDisplay?.commit(app);
          busy.clearActivity();
        }
        await this.applyRuntimeEvents(app, [event], tui);
        tui.requestRender();
      }
    } catch (error) {
      if (cancelled) {
        app.addMessage(systemMessage("Response stopped."));
        app.setStatus("ready");
      } else {
        app.addMessage(systemMessage(`Chat failed: ${formatPlainError(error)}`));
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

  private requestRunCommandApproval(
    app: ChatLayout,
    tui: TUI,
    busy: BusyIndicator,
    request: RunCommandApprovalRequest,
    abortSignal: AbortSignal
  ): Promise<RunCommandApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision: RunCommandApprovalDecision) => {
        if (settled) {
          return;
        }

        settled = true;
        abortSignal.removeEventListener("abort", abort);
        app.setModalActionHandler(undefined);
        app.dismissActiveModal();
        busy.clearActivity();
        resolve(decision);
      };
      const abort = () => settle("cancel");

      abortSignal.addEventListener("abort", abort, { once: true });
      app.setModalActionHandler((action) => {
        switch (action.value) {
          case "run_once":
          case "allow_session":
            settle(action.value);
            return;
          case "allow_repo":
            void this.persistRunCommandApproval(request.command)
              .then(() => settle("allow_repo"))
              .catch((error: unknown) => {
                app.addMessage(systemMessage(`Could not save command approval: ${formatPlainError(error)}`));
                settle("cancel");
              });
            return;
          default:
            settle("cancel");
        }
      });
      app.addMessage({
        kind: "modal",
        tone: "warning",
        title: "Run command?",
        body: `${request.command}\n\n${request.reason}`,
        actions: [
          { label: "Run once", value: "run_once" },
          { label: "Always allow exact command this session", value: "allow_session" },
          { label: "Always allow exact command for this repo", value: "allow_repo" },
          { label: "Cancel", value: "cancel" },
        ],
      });
      busy.setActivity("Waiting for command approval...");
      tui.requestRender();
    });
  }

  private async persistRunCommandApproval(command: string): Promise<void> {
    await addProjectCommandAllowExactRule(this.context.workspaceRoot, command);
    this.context.config.tools ??= {};
    const commands = (this.context.config.tools.commands ??= { allow: [], allowExact: [], deny: [] });
    commands.allowExact ??= [];

    if (!commands.allowExact.includes(command)) {
      commands.allowExact.push(command);
    }
  }

  private async submitSlashCommand(app: ChatLayout, tui: TUI, command: string): Promise<void> {
    if (isNewSessionCommand(command)) {
      await this.startNewSession(app, tui);
      return;
    }

    const busy = new BusyIndicator(app, tui, {
      status: "running command",
      promptHint: "working...",
      activities: getSlashCommandActivities(command),
      activityEveryMs: 5000,
    });

    busy.start();
    tui.requestRender();

    try {
      await this.clearTaskPlanForNewTurn(app);
      await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));
      await this.applyRuntimeEvents(
        app,
        await this.runtime.submitSlashCommand(command, (event) => {
          busy.setActivity(event.message);
        }),
        tui
      );
    } catch (error) {
      app.addMessage(systemMessage(`Command failed: ${formatPlainError(error)}`));
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

  private async startNewSession(app: ChatLayout, tui: TUI): Promise<void> {
    if (this.taskPlanNoticeTimer) {
      clearTimeout(this.taskPlanNoticeTimer);
      this.taskPlanNoticeTimer = undefined;
    }

    const session = await createSession(this.context.workspaceRoot);
    const messages = getStartupThreadMessages(this.context);
    this.session = session;
    this.sessionStartedAt = Date.now();

    await persistMessagesWithWarning(session, messages, messages);
    app.resetForNewSession(messages);
    tui.requestRender();
    await this.checkAgent(app, tui);
  }

  private async applyRuntimeEvents(
    app: ChatLayout,
    events: AgentRuntimeEvent[],
    renderRequester?: { requestRender(): void }
  ): Promise<void> {
    for (const event of events) {
      if (event.type === "status") {
        app.setStatus(event.status);
      }

      if (event.type === "knowledge_status") {
        app.setKnowledgeStatus(event.status);
      }

      if (event.type === "task_plan") {
        const change = app.setTaskPlan(event.plan);
        app.setTaskPlanNotice(formatTaskPlanNotice(change, event.plan));
        this.scheduleTaskPlanNoticeClear(app, renderRequester);
      }

      for (const message of renderRuntimeEvent(event)) {
        app.addMessage(message);
      }

      await this.persistPayloadWithWarning(app, runtimeEventToSessionPayload(event));
    }
  }

  private scheduleTaskPlanNoticeClear(app: ChatLayout, renderRequester: { requestRender(): void } | undefined): void {
    if (this.taskPlanNoticeTimer) {
      clearTimeout(this.taskPlanNoticeTimer);
      this.taskPlanNoticeTimer = undefined;
    }

    if (!renderRequester) {
      return;
    }

    this.taskPlanNoticeTimer = setTimeout(() => {
      this.taskPlanNoticeTimer = undefined;
      app.setTaskPlanNotice(undefined);
      renderRequester.requestRender();
    }, 2500);
    this.taskPlanNoticeTimer.unref?.();
  }

  private async clearTaskPlanForNewTurn(app: ChatLayout): Promise<void> {
    const clearedPlan = app.clearTaskPlan();

    if (!clearedPlan) {
      return;
    }

    await this.persistPayloadWithWarning(app, {
      kind: "task_plan",
      items: clearedPlan.items,
      updatedAt: clearedPlan.updatedAt,
    });
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

  private printExitBannerForCurrentSession(fallbackSession: SessionHandle): void {
    const session = this.session ?? fallbackSession;

    printExitBanner(session.sessionId, Date.now() - this.sessionStartedAt);
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
  if (message.kind === "system" || message.kind === "user") {
    return {
      kind: "message",
      role: message.kind,
      text: message.text,
    };
  }

  if (message.kind === "agent") {
    return {
      kind: "message",
      role: "assistant",
      text: message.text,
      ...(message.meta === undefined ? {} : { meta: message.meta }),
    };
  }

  if (message.kind === "thinking") {
    return undefined;
  }

  if (message.kind === "subagent") {
    return undefined;
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

  if (message.kind === "tool_call") {
    return {
      kind: "tool_call",
      label: message.label,
      call: message.call as unknown as Record<string, unknown>,
    };
  }

  return undefined;
}

export function slashCommandToSessionPayload(command: string): SessionEventPayload {
  return {
    kind: "message",
    role: "user",
    text: command,
    meta: { source: "slash_command", visibleOnly: true },
  };
}

export function isStreamReasoningEnabledByEnv(): boolean {
  const value = process.env.TOPCHESTER_STREAM_REASONING?.trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function createBusyReasoningSink(busy: BusyIndicator): { sink: ModelReasoningSink; commit(app: ChatLayout): void } {
  const buffer = new ReasoningTailBuffer();
  let committed = false;

  return {
    commit(app: ChatLayout) {
      if (committed || !buffer.hasText) {
        return;
      }

      app.addMessage(thinkingMessage(buffer.value));
      committed = true;
    },
    async sink(event: ModelReasoningEvent) {
      if (event.type === "clear") {
        buffer.clear();
        committed = false;
        busy.clearActivity();
        return;
      }

      const text = event.type === "summary" ? buffer.replace(event.text ?? "") : buffer.append(event.text ?? "");

      if (!text) {
        return;
      }

      busy.setActivity(ui.muted(text));
    },
  };
}

function formatPlainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "Unknown error";
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
  if (command.startsWith("/kb compile") || command.startsWith("/kb sync")) {
    return [
      "Checking project knowledge folders...",
      "Reading .gitignore files...",
      command.startsWith("/kb sync") ? "Checking KB file status..." : "Listing project files...",
      "Queueing L1 work...",
    ];
  }

  if (command.startsWith("/kb reset")) {
    return ["Checking project knowledge paths...", "Removing knowledge folder...", "Removing local cache folder..."];
  }

  return ["Running command...", "Preparing project knowledge folders...", "Writing project knowledge folders..."];
}

function isNewSessionCommand(command: string): boolean {
  return command.trim() === "/new";
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
