import { ABORT_CHOICE_VALUE, type AgentRuntimeEvent } from "../agent/events.js";
import {
  MutableRuntimeSteeringBuffer,
  TopchesterAgentRuntime,
  type AgentRuntime,
  type BashApprovalDecision,
  type BashApprovalRequest,
  type RuntimeSteeringBuffer,
} from "../agent/runtime/index.js";
import { formatTaskPlanNotice, type TaskPlanState } from "../agent/task-plan.js";
import {
  reloadAppBaseConfig,
  resetRuntimeConfigOverrides,
  restoreRuntimeConfigOverrides,
  setRuntimeActiveModel,
  setRuntimeReasoningEffort,
  type AppContext,
} from "../app/context.js";
import {
  addGlobalModelChoices,
  configureOpenRouterGlobalProvider,
  formatModelRef,
  getActiveModelProviderId,
  getConfiguredModelChoices,
  getConfiguredReasoningEffort,
  reasoningEfforts,
  resolveModelChoice,
  type ReasoningEffort,
} from "../config/index.js";
import { fallbackOpenRouterStarterChoices, selectOpenRouterStarterChoices } from "../model/openrouter.js";
import { createHerdrAgentReporter, type HerdrAgentReporter, type HerdrAgentState } from "../integrations/herdr.js";
import { type SessionEventPayload } from "../session/events.js";
import { basename } from "node:path";
import { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";
import {
  createSession,
  forkSession,
  listSessionSummaries,
  loadSession,
  loadSessionForAppend,
  rehydrateSession,
  type SessionHandle,
} from "../session/store.js";
import { slashCommandToSessionPayload, transcriptEntryToSessionPayload } from "../session/transcript-payloads.js";
import {
  createSkillsService,
  formatSkillActivationNotice,
  formatSkillActivationPrompt,
  type LoadedSkill,
  type SkillActivation,
  type SkillsService,
} from "../skills/index.js";
import { ControllerBusyIndicator, createControllerReasoningSink } from "./controller-busy.js";
import {
  formatAgentCheckSetupHint,
  formatPlainError,
  getModelLabel,
  getSlashCommandActivities,
  getSlashCommandArgs,
  isConnectCommand,
  isForkSessionCommand,
  isModelCommand,
  isNewSessionCommand,
  isReasoningEffort,
  isReasoningEffortCommand,
  isRestoreSessionCommand,
  isStreamReasoningEnabledByEnv,
  parseQueueCommandPrompt,
  parseSteerCommandPrompt,
  persistBashApproval,
} from "./controller-helpers.js";
import { TuiViewStore, type TuiViewListener, type TuiViewState } from "./controller-state.js";
import {
  fetchOpenRouterChoicesWithFallback,
  filterOpenRouterChoices,
  formatHomeRelativePath,
  formatModelPickerLabel,
} from "./model-picker.js";
import { runtimeEventToTranscriptEntries } from "./runtime-events.js";
import {
  createSkillInspectActions,
  createSkillsOverlayActions,
  filterSkillsForOverlay,
  formatSkillInspectBody,
  formatSkillsOverlayBody,
  SKILL_OVERLAY_BACK_VALUE,
  SKILL_OVERLAY_RELOAD_VALUE,
} from "./skills-overlay.js";
import { createStartupTranscriptEntry } from "./startup.js";
import {
  systemTranscriptEntry,
  userTranscriptEntry,
  type ChoiceTranscriptAction,
  type ChoiceTranscriptEntry,
  type TranscriptEntry,
} from "./transcript.js";

export const STARTUP_PROMPT_HINT =
  "Prompt hint: Enter sends, Shift+Enter adds a line, / opens commands, ↑↓ browse history.";

const HOOK_STATUS_EXPIRE_AFTER_MS = 2000;

export interface TuiControllerOptions {
  session?: SessionHandle;
  initialTranscript?: TranscriptEntry[];
  initialTaskPlan?: TaskPlanState;
  runtimeConfigWarnings?: string[];
  banner?: string;
  herdrReporter?: HerdrAgentReporter;
}

export interface TuiController {
  getSnapshot(): TuiViewState;
  subscribe(listener: TuiViewListener): () => void;
  submit(input: string): "submitted" | "queued";
  submitCommand(command: string): "submitted" | "queued";
  cancel(): void;
  choose(action: ChoiceTranscriptAction): void;
  selectSession(sessionId: string): void;
  cancelSessionPicker(): void;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export class TopchesterTuiController implements TuiController {
  private readonly runtime: AgentRuntime;
  private readonly skillsService: SkillsService;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly view: TuiViewStore;
  private session: SessionHandle;
  private sessionStartedAt = Date.now();
  private taskPlanNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private knowledgeStatusTimer: ReturnType<typeof setInterval> | undefined;
  private pendingSkillActivations: LoadedSkill[] = [];
  private chatRunning = false;
  private queuedChatMessages: string[] = [];
  private activeSteeringBuffer: MutableRuntimeSteeringBuffer | undefined;
  private cancelPending: (() => void) | undefined;
  private dialogHandler: ((action: ChoiceTranscriptAction) => void) | undefined;
  private sessionPickerSelectionHandler: ((sessionId: string) => void) | undefined;
  private sessionPickerCancelHandler: (() => void) | undefined;
  private disposed = false;
  private readonly herdrReporter: HerdrAgentReporter;
  private readonly stopHerdrStateSync: () => void;
  private herdrBlocked = false;

  private constructor(
    private readonly context: AppContext,
    runtime: AgentRuntime,
    session: SessionHandle,
    transcript: TranscriptEntry[],
    private readonly options: TuiControllerOptions
  ) {
    this.runtime = runtime;
    this.session = session;
    this.skillsService = createSkillsService({ workspaceRoot: context.workspaceRoot });
    this.view = new TuiViewStore({
      sessionId: session.sessionId,
      workspaceLabel: basename(context.workspaceRoot) || context.workspaceRoot,
      transcript,
      modelLabel: getModelLabel(context),
      taskPlan: options.initialTaskPlan,
      ...(options.session === undefined ? { startupHint: STARTUP_PROMPT_HINT } : {}),
    });
    this.herdrReporter = options.herdrReporter ?? createHerdrAgentReporter();
    this.stopHerdrStateSync = this.view.subscribe(() => this.syncHerdrState());
  }

  static async create(
    context: AppContext,
    runtime?: AgentRuntime,
    options: TuiControllerOptions = {}
  ): Promise<TopchesterTuiController> {
    const session = options.session ?? (await createSession(context.workspaceRoot));
    const transcript = [
      ...(options.initialTranscript ?? [createStartupTranscriptEntry(context, { banner: options.banner })]),
    ];
    for (const warning of options.runtimeConfigWarnings ?? []) {
      transcript.push(systemTranscriptEntry(`Session config warning: ${warning}`));
    }
    const controller = new TopchesterTuiController(
      context,
      runtime ?? new TopchesterAgentRuntime(context),
      session,
      transcript,
      options
    );
    await controller.initialize(options.session !== undefined);
    controller.syncHerdrState();
    return controller;
  }

  getSnapshot(): TuiViewState {
    return this.view.getSnapshot();
  }

  subscribe(listener: TuiViewListener): () => void {
    return this.view.subscribe(listener);
  }

  start(): void {
    this.ensureActive();
    this.startKnowledgeStatusRefresh();
    this.startBackgroundTask("Agent check", () => this.checkAgent());
  }

  submit(input: string): "submitted" | "queued" {
    this.ensureActive();
    const message = input.trim();
    if (!message) {
      return "submitted";
    }
    if (this.chatRunning) {
      this.enqueueChatMessage(message);
      return "queued";
    }
    this.view.addEntry(userTranscriptEntry(message));
    this.clearInputNotices();
    this.startBackgroundTask("Chat", () => this.submitChatMessage(message));
    return "submitted";
  }

  submitCommand(command: string): "submitted" | "queued" {
    this.ensureActive();
    const queuedPrompt = parseQueueCommandPrompt(command);
    if (queuedPrompt !== undefined) {
      this.submitQueueCommand(queuedPrompt);
      return "queued";
    }
    const steeringPrompt = parseSteerCommandPrompt(command);
    if (steeringPrompt !== undefined) {
      this.submitSteerCommand(steeringPrompt);
      return "queued";
    }
    this.view.addEntry(userTranscriptEntry(command));
    this.clearInputNotices();
    this.startBackgroundTask("Command", () => this.dispatchSlashCommand(command));
    return "submitted";
  }

  cancel(): void {
    this.cancelPending?.();
  }

  choose(action: ChoiceTranscriptAction): void {
    const handler = this.dialogHandler;
    this.dialogHandler = undefined;
    this.view.removeActiveChoice();
    if (handler) {
      handler(action);
      return;
    }
    if (action.value === ABORT_CHOICE_VALUE) {
      this.view.addEntry(userTranscriptEntry(action.label, { modelContext: false }));
      return;
    }
    const value = action.value ?? action.label;
    if (value.startsWith("/")) {
      this.submitCommand(value);
    } else {
      this.submit(value);
    }
  }

  dismissDialog(): void {
    if (this.dialogHandler) {
      this.choose({ label: "Cancel", value: "cancel" });
      return;
    }
    this.view.removeActiveChoice();
    this.view.addEntry(userTranscriptEntry("Cancel"));
  }

  selectSession(sessionId: string): void {
    this.sessionPickerSelectionHandler?.(sessionId);
  }

  cancelSessionPicker(): void {
    this.view.closeSessionPicker();
    this.sessionPickerCancelHandler?.();
  }

  setNoticeLine(line: string | undefined): void {
    this.view.setNoticeLine(line);
  }

  getSessionInfo(): { sessionId: string; durationMs: number } {
    return { sessionId: this.session.sessionId, durationMs: Date.now() - this.sessionStartedAt };
  }

  async waitForIdle(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled(this.backgroundTasks);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelPending?.();
    this.stopKnowledgeStatusRefresh();
    if (this.taskPlanNoticeTimer) {
      clearTimeout(this.taskPlanNoticeTimer);
      this.taskPlanNoticeTimer = undefined;
    }
    this.view.dispose();
    await Promise.allSettled(this.backgroundTasks);
    this.stopHerdrStateSync();
    await this.herdrReporter.release();
  }

  async applyRuntimeEvents(events: AgentRuntimeEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === "status") {
        this.view.setStatus(event.status);
      }
      if (event.type === "knowledge_status") {
        this.view.setKnowledgeStatus(event.status);
      }
      if (event.type === "task_plan") {
        const change = this.view.setTaskPlan(event.plan);
        this.view.setTaskPlanNotice(formatTaskPlanNotice(change, event.plan));
        this.scheduleTaskPlanNoticeClear();
      }
      if (event.type === "hook_status") {
        this.view.setTemporaryLine(event.label, HOOK_STATUS_EXPIRE_AFTER_MS);
      } else {
        this.view.addEntries(runtimeEventToTranscriptEntries(event));
      }
      await this.persistPayloadWithWarning(runtimeEventToSessionPayload(event));
    }
  }

  private async initialize(isResumed: boolean): Promise<void> {
    this.sessionStartedAt = Date.now();
    if (!isResumed) {
      for (const entry of this.view.getSnapshot().transcript) {
        await this.persistPayloadWithWarning(transcriptEntryToSessionPayload(entry));
      }
    }
    await this.appendStartupRuntimeEvents(
      (await this.runtime.runSessionStartHooks?.(this.session, { isResumed })) ?? []
    );
    await this.appendStartupRuntimeEvents((await this.runtime.checkProjectInstructions?.()) ?? []);
  }

  private startBackgroundTask(label: string, task: () => Promise<void>): void {
    const promise = task()
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.view.addEntry(systemTranscriptEntry(`${label} failed: ${formatPlainError(error)}`));
          this.view.setStatus("ready");
          this.setCancelPending(undefined);
        }
      })
      .finally(() => this.backgroundTasks.delete(promise));
    this.backgroundTasks.add(promise);
  }

  private async checkAgent(): Promise<void> {
    const busy = new ControllerBusyIndicator(this.view, {
      status: "checking agent",
      promptHint: "press Esc to stop",
      activities: ["Checking model config...", "Calling agent.fast...", "Waiting for model..."],
    });
    const abortController = new AbortController();
    let cancelled = false;
    const cancelRequest = () => {
      cancelled = true;
      abortController.abort();
    };
    this.setCancelPending(cancelRequest);
    busy.start();
    try {
      await this.applyRuntimeEvents(await this.runtime.checkAgent(abortController.signal));
    } catch (error) {
      if (cancelled) {
        this.view.addEntry(systemTranscriptEntry("Agent check stopped."));
        this.view.setStatus("ready");
      } else {
        const message = formatPlainError(error);
        const setupHint = formatAgentCheckSetupHint(message, this.context);
        this.view.addEntry(systemTranscriptEntry(`Agent check failed: ${message}${setupHint ? `\n${setupHint}` : ""}`));
        this.view.setStatus("agent check failed");
      }
    } finally {
      this.clearCancelPending(cancelRequest);
      busy.stop();
    }
    if (this.view.isReady()) {
      await this.applyRuntimeEvents(await this.runtime.checkKnowledgeBase());
    }
  }

  private async submitChatMessage(message: string): Promise<void> {
    if (this.chatRunning) {
      this.enqueueChatMessage(message);
      return;
    }
    const activeSession = this.session;
    const steering = new MutableRuntimeSteeringBuffer();
    const busy = new ControllerBusyIndicator(this.view, {
      status: "thinking",
      activityHint: "press Esc to stop",
      activities: ["Thinking...", "Calling model...", "Writing response..."],
    });
    const abortController = new AbortController();
    const reasoningDisplay = isStreamReasoningEnabledByEnv()
      ? createControllerReasoningSink(this.view, busy)
      : undefined;
    let cancelled = false;
    this.activeSteeringBuffer = steering;
    const cancelRequest = () => {
      cancelled = true;
      abortController.abort();
    };
    this.setCancelPending(cancelRequest);
    this.chatRunning = true;
    this.refreshQueuedChatStatus();
    busy.start();
    try {
      await this.clearTaskPlanForNewTurn();
      await this.persistPayloadWithWarning({ kind: "message", role: "user", text: message });
      const pendingSkills = this.pendingSkillActivations.splice(0);
      const modelMessage = pendingSkills.length
        ? formatSkillActivationPrompt(pendingSkills.map((skill) => ({ skill, instruction: message })))
        : message;
      const conversation =
        modelMessage === message ? this.view.getConversationTurns() : this.view.getConversationTurns().slice(0, -1);
      for await (const event of this.runtime.submitMessageStream(conversation, modelMessage, abortController.signal, {
        onReasoning: reasoningDisplay?.sink,
        session: this.session,
        requestBashApproval: (request) => this.requestBashApproval(busy, request, abortController.signal),
        steering,
      })) {
        if (this.session !== activeSession) {
          break;
        }
        if (event.type === "message" && event.role === "assistant") {
          reasoningDisplay?.commit();
          busy.clearActivity();
        }
        await this.applyRuntimeEvents([event]);
      }
    } catch (error) {
      if (this.session !== activeSession) {
        // A session switch owns the next visible state; the abandoned turn must not write into it.
      } else if (cancelled) {
        this.view.addEntry(systemTranscriptEntry("Response stopped."));
        this.view.setStatus("ready");
      } else {
        this.view.addEntry(systemTranscriptEntry(`Chat failed: ${formatPlainError(error)}`));
        this.view.setStatus("chat failed");
        await this.persistPayloadWithWarning({ kind: "status", status: "chat failed" });
      }
    } finally {
      this.clearCancelPending(cancelRequest);
      this.chatRunning = false;
      if (this.activeSteeringBuffer === steering) {
        this.activeSteeringBuffer = undefined;
      }
      const sessionStillActive = this.session === activeSession;
      busy.stop({ clearEphemeral: sessionStillActive, clearPromptHint: sessionStillActive });
      if (sessionStillActive && this.view.getSnapshot().status === "thinking") {
        this.view.setStatus("ready");
      }
    }
    if (this.session === activeSession) {
      this.handleUnconsumedSteering(steering, cancelled);
    }
    if (this.session === activeSession && this.view.isReady()) {
      await this.drainQueuedChatMessages();
    }
  }

  private enqueueChatMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed) {
      this.queuedChatMessages.push(trimmed);
      this.refreshQueuedChatStatus();
    }
  }

  private submitQueueCommand(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) {
      this.view.addEntry(systemTranscriptEntry("Usage: /queue <prompt>"));
    } else if (this.chatRunning) {
      this.enqueueChatMessage(trimmed);
    } else {
      this.view.addEntry(userTranscriptEntry(trimmed));
      this.startBackgroundTask("Chat", () => this.submitChatMessage(trimmed));
    }
  }

  private submitSteerCommand(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) {
      this.view.addEntry(systemTranscriptEntry("Usage: /steer <prompt>"));
    } else if (!this.chatRunning) {
      this.view.addEntry(userTranscriptEntry(trimmed));
      this.startBackgroundTask("Chat", () => this.submitChatMessage(trimmed));
    } else if (!this.activeSteeringBuffer) {
      this.enqueueChatMessage(trimmed);
    } else {
      this.activeSteeringBuffer.push(trimmed);
      this.view.setTemporaryLine("steering added to active turn", 2000);
    }
  }

  private handleUnconsumedSteering(steering: RuntimeSteeringBuffer, cancelled: boolean): void {
    const pending = steering.drain();
    if (!pending) {
      return;
    }
    if (cancelled) {
      this.view.addEntry(systemTranscriptEntry("Dropped pending steering after response stopped."));
    } else {
      this.enqueueChatMessage(pending);
    }
  }

  private async drainQueuedChatMessages(): Promise<void> {
    while (!this.chatRunning && this.view.isReady()) {
      const message = this.queuedChatMessages.shift();
      this.refreshQueuedChatStatus();
      if (!message) {
        return;
      }
      this.view.addEntry(userTranscriptEntry(message));
      await this.submitChatMessage(message);
    }
  }

  private refreshQueuedChatStatus(): void {
    this.view.setQueuedFollowUps(this.queuedChatMessages.length, this.queuedChatMessages[0]);
  }

  private clearQueuedChatMessages(): string | undefined {
    const droppedCount = this.queuedChatMessages.length;
    this.queuedChatMessages = [];
    const droppedSteering = this.activeSteeringBuffer?.hasPending() ? this.activeSteeringBuffer.drain() : undefined;
    this.refreshQueuedChatStatus();
    if (droppedCount === 0 && !droppedSteering) {
      return undefined;
    }
    const suffix = droppedCount === 1 ? "follow-up" : "follow-ups";
    return [
      droppedCount ? `Dropped ${droppedCount} queued ${suffix}.` : "",
      droppedSteering ? "Dropped pending steering." : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private requestBashApproval(
    busy: ControllerBusyIndicator,
    request: BashApprovalRequest,
    abortSignal: AbortSignal
  ): Promise<BashApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision: BashApprovalDecision) => {
        if (settled) {
          return;
        }
        settled = true;
        abortSignal.removeEventListener("abort", abort);
        this.dialogHandler = undefined;
        this.view.removeActiveChoice();
        this.herdrBlocked = false;
        this.syncHerdrState();
        busy.clearActivity();
        resolve(decision);
      };
      const abort = () => settle("cancel");
      abortSignal.addEventListener("abort", abort, { once: true });
      this.herdrBlocked = true;
      void this.herdrReporter.report({
        state: "blocked",
        sessionId: this.session.sessionId,
        message: "Waiting for bash approval",
      });
      this.openManagedDialog(
        {
          kind: "choice",
          persistence: "session",
          tone: "warning",
          title: "Run bash command?",
          body: formatBashApprovalBody(request),
          actions: [
            { label: "Run once", value: "run_once" },
            { label: "Always allow exact command this session", value: "allow_session" },
            { label: "Always allow exact command for this repo", value: "allow_repo" },
            { label: "Cancel", value: "cancel" },
          ],
        },
        (action) => {
          if (action.value === "run_once" || action.value === "allow_session") {
            settle(action.value);
          } else if (action.value === "allow_repo") {
            void persistBashApproval(this.context, request.command)
              .then(() => settle("allow_repo"))
              .catch((error: unknown) => {
                this.view.addEntry(systemTranscriptEntry(`Could not save bash approval: ${formatPlainError(error)}`));
                settle("cancel");
              });
          } else {
            settle("cancel");
          }
        }
      );
      busy.setActivity("Waiting for bash approval...");
    });
  }

  private async dispatchSlashCommand(command: string): Promise<void> {
    const activation = await this.resolveSkillActivationCommand(command);
    if (activation) {
      await this.submitSkillActivationCommand(command, activation);
      return;
    }
    if (this.isSkillsOverlayCommand(command)) {
      await this.clearTaskPlanForNewTurn();
      await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
      await this.showSkillsOverlay(this.getSkillsOverlayFilter(command));
      return;
    }
    if (isNewSessionCommand(command)) {
      await this.startNewSession();
      return;
    }
    if (isForkSessionCommand(command)) {
      await this.forkCurrentSession();
      return;
    }
    if (isRestoreSessionCommand(command)) {
      await this.openRestoreSessionPicker(command);
      return;
    }
    if (isConnectCommand(command)) {
      await this.submitConnectCommand(command);
      return;
    }
    if (isModelCommand(command)) {
      await this.submitModelCommand(command);
      return;
    }
    if (isReasoningEffortCommand(command)) {
      await this.submitReasoningEffortCommand(command);
      return;
    }
    const busy = new ControllerBusyIndicator(this.view, {
      status: "running command",
      promptHint: "working...",
      activities: getSlashCommandActivities(command),
      activityEveryMs: 5000,
    });
    busy.start();
    try {
      await this.clearTaskPlanForNewTurn();
      await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
      await this.applyRuntimeEvents(
        await this.runtime.submitSlashCommand(command, (event) => busy.setActivity(event.message))
      );
    } catch (error) {
      this.view.addEntry(systemTranscriptEntry(`Command failed: ${formatPlainError(error)}`));
      this.view.setStatus("command failed");
      await this.persistPayloadWithWarning({ kind: "status", status: "command failed" });
    } finally {
      busy.stop();
    }
  }

  private async submitSkillActivationCommand(command: string, activation: SkillActivation): Promise<void> {
    await this.clearTaskPlanForNewTurn();
    await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
    const hasInstruction = activation.instruction.trim().length > 0;
    this.view.addEntry(systemTranscriptEntry(formatSkillActivationNotice(activation.skill.name, hasInstruction)));
    if (!hasInstruction) {
      this.pendingSkillActivations.push(activation.skill);
      return;
    }

    const busy = new ControllerBusyIndicator(this.view, {
      status: "thinking",
      promptHint: "press Esc to stop",
      activities: ["Loading skill...", "Calling model...", "Writing response..."],
    });
    const abortController = new AbortController();
    const reasoningDisplay = isStreamReasoningEnabledByEnv()
      ? createControllerReasoningSink(this.view, busy)
      : undefined;
    let cancelled = false;
    const activeSession = this.session;
    const cancelRequest = () => {
      cancelled = true;
      abortController.abort();
    };
    this.setCancelPending(cancelRequest);
    busy.start();
    try {
      const conversation = this.view.getConversationTurns().slice(0, -1);
      for await (const event of this.runtime.submitMessageStream(
        conversation,
        formatSkillActivationPrompt([activation]),
        abortController.signal,
        {
          onReasoning: reasoningDisplay?.sink,
          session: this.session,
          requestBashApproval: (request) => this.requestBashApproval(busy, request, abortController.signal),
        }
      )) {
        if (this.session !== activeSession) {
          break;
        }
        if (event.type === "message" && event.role === "assistant") {
          reasoningDisplay?.commit();
          busy.clearActivity();
        }
        await this.applyRuntimeEvents([event]);
      }
    } catch (error) {
      if (this.session !== activeSession) {
        // Ignore output from a skill turn abandoned by a session switch.
      } else if (cancelled) {
        this.view.addEntry(systemTranscriptEntry("Response stopped."));
        this.view.setStatus("ready");
      } else {
        this.view.addEntry(systemTranscriptEntry(`Chat failed: ${formatPlainError(error)}`));
        this.view.setStatus("chat failed");
        await this.persistPayloadWithWarning({ kind: "status", status: "chat failed" });
      }
    } finally {
      this.clearCancelPending(cancelRequest);
      const sessionStillActive = this.session === activeSession;
      busy.stop({ clearEphemeral: sessionStillActive, clearPromptHint: sessionStillActive });
    }
  }

  private async resolveSkillActivationCommand(command: string): Promise<SkillActivation | undefined> {
    const parts = command.trim().slice(1).split(/\s+/u).filter(Boolean);
    const name = parts[0]?.toLowerCase();
    if (
      !name ||
      name === "skills" ||
      name === "kb" ||
      isNewSessionCommand(command) ||
      isConnectCommand(command) ||
      isModelCommand(command) ||
      isReasoningEffortCommand(command)
    ) {
      return undefined;
    }
    if (name === "skill") {
      const skillName = parts[1];
      return skillName
        ? { skill: await this.skillsService.viewSkill(skillName), instruction: parts.slice(2).join(" ") }
        : undefined;
    }
    try {
      return { skill: await this.skillsService.viewSkill(name), instruction: parts.slice(1).join(" ") };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown skill:")) {
        return undefined;
      }
      throw error;
    }
  }

  private isSkillsOverlayCommand(command: string): boolean {
    const parts = command.trim().slice(1).split(/\s+/u).filter(Boolean);
    return (
      parts[0]?.toLowerCase() === "skills" && !["list", "inspect", "reload"].includes(parts[1]?.toLowerCase() ?? "")
    );
  }

  private getSkillsOverlayFilter(command: string): string {
    return command.trim().slice(1).split(/\s+/u).filter(Boolean).slice(1).join(" ");
  }

  private async showSkillsOverlay(query = ""): Promise<void> {
    const skills = await this.skillsService.listSkills();
    const visible = filterSkillsForOverlay(skills.active, query);
    this.openManagedDialog(
      {
        kind: "choice",
        persistence: "session",
        tone: "info",
        title: query ? `Skills: ${query}` : "Skills",
        body: formatSkillsOverlayBody(skills, visible),
        actions: createSkillsOverlayActions(visible),
      },
      (action) => {
        const value = action.value;
        if (value === SKILL_OVERLAY_RELOAD_VALUE) {
          this.skillsService.reload();
          this.startBackgroundTask("Skills", () => this.showSkillsOverlay(query));
        } else if (value?.startsWith("inspect:")) {
          this.startBackgroundTask("Skills", () => this.showSkillInspectOverlay(value.slice(8), query));
        }
      }
    );
  }

  private async showSkillInspectOverlay(skillName: string, query = ""): Promise<void> {
    const skill = await this.skillsService.viewSkill(skillName);
    this.openManagedDialog(
      {
        kind: "choice",
        persistence: "session",
        tone: "info",
        title: skill.name,
        body: formatSkillInspectBody(skill),
        actions: createSkillInspectActions(skill),
      },
      (action) => {
        const value = action.value;
        if (value === SKILL_OVERLAY_BACK_VALUE) {
          this.startBackgroundTask("Skills", () => this.showSkillsOverlay(query));
        } else if (value?.startsWith("activate:")) {
          this.pendingSkillActivations.push(skill);
          this.view.addEntry(systemTranscriptEntry(formatSkillActivationNotice(skill.name, false)));
        }
      }
    );
  }

  private async submitConnectCommand(command: string): Promise<void> {
    await this.clearTaskPlanForNewTurn();
    await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
    const args = getSlashCommandArgs(command);
    if (args.length === 0) {
      this.showProviderPicker();
    } else if (args.length === 1 && args[0]?.toLowerCase() === "openrouter") {
      await this.connectOpenRouter();
    } else {
      this.view.addEntry(systemTranscriptEntry("Usage: /connect openrouter"));
    }
  }

  private async submitModelCommand(command: string): Promise<void> {
    await this.clearTaskPlanForNewTurn();
    await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
    const args = getSlashCommandArgs(command);
    if (args[0]?.toLowerCase() === "all") {
      await this.showOpenRouterCatalogPicker(args.slice(1).join(" "));
      return;
    }
    const query = args.join(" ");
    const choices = getConfiguredModelChoices(this.context.config);
    if (choices.length === 0) {
      this.view.addEntry(systemTranscriptEntry("No model choices are set yet. Run /connect openrouter first."));
      return;
    }
    const exact = choices.find((choice) => formatModelRef(choice) === query);
    if (exact) {
      await this.selectModelChoice(formatModelRef(exact));
    } else {
      this.showModelPicker(query);
    }
  }

  private async submitReasoningEffortCommand(command: string): Promise<void> {
    await this.clearTaskPlanForNewTurn();
    await this.persistPayloadWithWarning(slashCommandToSessionPayload(command));
    const args = getSlashCommandArgs(command);
    const value = args[0]?.toLowerCase();
    if (args.length === 0) {
      this.view.addEntry(
        systemTranscriptEntry(formatCurrentReasoningEffortMessage(getConfiguredReasoningEffort(this.context.config)))
      );
    } else if (args.length > 1) {
      this.view.addEntry(systemTranscriptEntry(formatReasoningEffortUsageMessage()));
    } else if (value === "clear" || value === "default") {
      await this.updateReasoningEffort(undefined);
    } else if (!isReasoningEffort(value, reasoningEfforts)) {
      this.view.addEntry(systemTranscriptEntry(formatReasoningEffortUsageMessage()));
    } else {
      await this.updateReasoningEffort(value);
    }
  }

  private async updateReasoningEffort(effort: ReasoningEffort | undefined): Promise<void> {
    try {
      const providerId = getActiveModelProviderId(this.context.config);
      if (!providerId) {
        this.view.addEntry(
          systemTranscriptEntry(
            "No provider configured for the active model. Run /connect codex or configure a provider first."
          )
        );
        return;
      }
      setRuntimeReasoningEffort(this.context, providerId, effort);
      this.view.setModelLabel(getModelLabel(this.context));
      await this.persistRuntimeConfigWithWarning();
      this.view.addEntry(
        systemTranscriptEntry(
          effort === undefined
            ? "Session reasoning override cleared; the configured provider effort now applies."
            : `Reasoning effort set to ${effort} for this session.`
        )
      );
      this.view.setStatus("ready");
    } catch (error) {
      this.view.addEntry(systemTranscriptEntry(`Reasoning effort change failed: ${formatPlainError(error)}`));
      this.view.setStatus("reasoning effort change failed");
    }
  }

  private showProviderPicker(): void {
    this.openManagedDialog(
      {
        kind: "choice",
        persistence: "session",
        tone: "info",
        title: "Connect provider",
        body: "OpenRouter is the first provider in V0. Topchester will use OPENROUTER_API_KEY from your environment.",
        actions: [
          { label: "OpenRouter", value: "openrouter" },
          { label: "Cancel", value: "cancel" },
        ],
      },
      (action) => {
        if (action.value === "openrouter") {
          this.startBackgroundTask("Connect", () => this.connectOpenRouter());
        }
      }
    );
  }

  private showModelPicker(query = ""): void {
    const normalizedQuery = query.trim().toLowerCase();
    const choices = getConfiguredModelChoices(this.context.config).filter((choice) => {
      const ref = formatModelRef(choice).toLowerCase();
      return !normalizedQuery || ref.includes(normalizedQuery) || choice.name.toLowerCase().includes(normalizedQuery);
    });
    if (choices.length === 0) {
      this.view.addEntry(
        systemTranscriptEntry("No model choices matched. Use /model all to browse OpenRouter models.")
      );
      return;
    }
    this.openManagedDialog(
      {
        kind: "choice",
        persistence: "session",
        tone: "info",
        title: "Choose model",
        body: `Current: ${getModelLabel(this.context)}`,
        actions: [
          ...choices.map((choice) => {
            const ref = formatModelRef(choice);
            return { label: formatModelPickerLabel(ref), value: `model:${ref}` };
          }),
          { label: "Cancel", value: "cancel" },
        ],
      },
      (action) => {
        if (action.value?.startsWith("model:")) {
          this.startBackgroundTask("Model", () => this.selectModelChoice(action.value!.slice(6)));
        }
      }
    );
  }

  private async showOpenRouterCatalogPicker(query = ""): Promise<void> {
    const busy = new ControllerBusyIndicator(this.view, {
      status: "loading models",
      promptHint: "working...",
      activities: ["Asking OpenRouter for models...", "Filtering text models...", "Building model choices..."],
    });
    busy.start();
    try {
      const matches = filterOpenRouterChoices(await fetchOpenRouterChoicesWithFallback(), query);
      if (matches.length === 0) {
        this.view.addEntry(systemTranscriptEntry("No OpenRouter models matched."));
        return;
      }
      this.openManagedDialog(
        {
          kind: "choice",
          persistence: "session",
          tone: "info",
          title: "OpenRouter models",
          body: "Picking one adds it to the global choices catalog and selects it for this session.",
          actions: [
            ...matches.map((choice) => ({
              label: `${formatModelPickerLabel(choice.ref)}  ${choice.description}`,
              value: `model:${choice.ref}`,
            })),
            { label: "Cancel", value: "cancel" },
          ],
        },
        (action) => {
          if (action.value?.startsWith("model:")) {
            this.startBackgroundTask("Model", () =>
              this.selectModelChoice(action.value!.slice(6), { persistChoice: true })
            );
          }
        }
      );
    } catch (error) {
      this.view.addEntry(systemTranscriptEntry(`Could not load OpenRouter models: ${formatPlainError(error)}`));
    } finally {
      busy.stop();
    }
  }

  private async connectOpenRouter(): Promise<void> {
    const busy = new ControllerBusyIndicator(this.view, {
      status: "connecting provider",
      promptHint: "working...",
      activities: ["Saving OpenRouter provider...", "Loading OpenRouter models...", "Updating local choices..."],
    });
    busy.start();
    try {
      const providerResult = await configureOpenRouterGlobalProvider();
      let starterChoices: string[];
      try {
        starterChoices = selectOpenRouterStarterChoices(await fetchOpenRouterChoicesWithFallback());
      } catch {
        starterChoices = fallbackOpenRouterStarterChoices();
      }
      await addGlobalModelChoices(starterChoices, { prioritize: true });
      reloadAppBaseConfig(this.context);
      if (!this.context.config.models?.assignments?.["agent.primary"] && starterChoices[0]) {
        setRuntimeActiveModel(this.context, resolveModelChoice(this.context.config, starterChoices[0]));
        await this.persistRuntimeConfigWithWarning();
      }
      this.view.setModelLabel(getModelLabel(this.context));
      await this.refreshKnowledgeFooter();
      this.view.addEntry(
        systemTranscriptEntry(
          [
            "OpenRouter is connected.",
            `config: ${formatHomeRelativePath(providerResult.path)}`,
            process.env.OPENROUTER_API_KEY
              ? "OPENROUTER_API_KEY is set."
              : "Set OPENROUTER_API_KEY before sending model requests.",
            "Run /model to choose one of the saved choices.",
          ].join("\n")
        )
      );
      this.showModelPicker();
    } catch (error) {
      this.view.addEntry(systemTranscriptEntry(`OpenRouter setup failed: ${formatPlainError(error)}`));
      this.view.setStatus("provider setup failed");
    } finally {
      busy.stop();
    }
  }

  private async selectModelChoice(modelRef: string, options: { persistChoice?: boolean } = {}): Promise<void> {
    try {
      if (options.persistChoice) {
        await configureOpenRouterGlobalProvider();
        await addGlobalModelChoices([modelRef], { prioritize: true });
        reloadAppBaseConfig(this.context);
      }
      setRuntimeActiveModel(this.context, resolveModelChoice(this.context.config, modelRef));
      this.view.setModelLabel(getModelLabel(this.context));
      await this.persistRuntimeConfigWithWarning();
      await this.refreshKnowledgeFooter();
      this.view.addEntry(systemTranscriptEntry(`Model set to ${modelRef} for this session.`));
      this.view.setStatus("ready");
    } catch (error) {
      this.view.addEntry(systemTranscriptEntry(`Model change failed: ${formatPlainError(error)}`));
      this.view.setStatus("model change failed");
    }
  }

  private startKnowledgeStatusRefresh(): void {
    this.stopKnowledgeStatusRefresh();
    this.knowledgeStatusTimer = setInterval(() => {
      if (!this.view.isReady()) {
        return;
      }
      void this.refreshKnowledgeFooter()
        .then(() => this.context.logger.debug("Knowledge status refreshed"))
        .catch((error: unknown) => {
          this.context.logger.debug(
            { event: "knowledge_status_refresh_failed", error: formatPlainError(error) },
            "knowledge status refresh failed"
          );
        });
    }, 90_000);
    this.knowledgeStatusTimer.unref?.();
  }

  private stopKnowledgeStatusRefresh(): void {
    if (this.knowledgeStatusTimer) {
      clearInterval(this.knowledgeStatusTimer);
      this.knowledgeStatusTimer = undefined;
    }
  }

  private async refreshKnowledgeFooter(): Promise<void> {
    for (const event of await this.runtime.checkKnowledgeBase()) {
      if (event.type === "knowledge_status") {
        this.view.setKnowledgeStatus(event.status);
      }
    }
  }

  private async startNewSession(): Promise<void> {
    this.cancelPending?.();
    const droppedNotice = this.clearQueuedChatMessages();
    this.clearTaskPlanNoticeTimer();
    resetRuntimeConfigOverrides(this.context);
    const session = await createSession(this.context.workspaceRoot);
    const transcript: TranscriptEntry[] = [createStartupTranscriptEntry(this.context, { banner: this.options.banner })];
    if (droppedNotice) {
      transcript.push(systemTranscriptEntry(droppedNotice));
    }
    this.session = session;
    this.sessionStartedAt = Date.now();
    this.pendingSkillActivations = [];
    await this.persistInitialTranscript(transcript);
    await this.appendStartupRuntimeEvents(
      (await this.runtime.runSessionStartHooks?.(session, { isResumed: false })) ?? [],
      transcript
    );
    await this.appendStartupRuntimeEvents((await this.runtime.checkProjectInstructions?.()) ?? [], transcript);
    this.view.reset({
      sessionId: session.sessionId,
      transcript,
      modelLabel: getModelLabel(this.context),
      startupHint: STARTUP_PROMPT_HINT,
    });
    await this.checkAgent();
  }

  private async forkCurrentSession(): Promise<void> {
    this.cancelPending?.();
    const droppedNotice = this.clearQueuedChatMessages();
    this.clearTaskPlanNoticeTimer();
    const source = this.session;
    if (!source) {
      this.view.addEntry(systemTranscriptEntry("Fork failed: no active session."));
      return;
    }
    const fork = await forkSession(this.context.workspaceRoot, source.sessionId);
    const loaded = await loadSession(this.context.workspaceRoot, fork.sessionId);
    const rehydrated = rehydrateSession(loaded.events);
    const warnings = restoreRuntimeConfigOverrides(this.context, rehydrated.runtimeConfigOverrides);
    const noticeText = `Forked session from ${source.sessionId.slice(0, 8)}.`;
    const transcript = [
      ...rehydrated.transcript,
      ...warnings.map((warning) => systemTranscriptEntry(`Session config warning: ${warning}`)),
      systemTranscriptEntry(noticeText),
      ...(droppedNotice ? [systemTranscriptEntry(droppedNotice)] : []),
    ];
    this.session = fork;
    this.sessionStartedAt = Date.now();
    this.pendingSkillActivations = [];
    try {
      await fork.append({ kind: "message", role: "system", text: noticeText });
    } catch (error) {
      transcript.push(systemTranscriptEntry(`Session save failed: ${formatPlainError(error)}`));
    }
    this.view.reset({
      sessionId: fork.sessionId,
      transcript,
      modelLabel: getModelLabel(this.context),
      taskPlan: rehydrated.taskPlan,
      status: rehydrated.status,
    });
  }

  private async openRestoreSessionPicker(command: string): Promise<void> {
    this.view.discardLastUserEntry(command);
    if (!this.view.isReady()) {
      this.view.addEntry(systemTranscriptEntry("Restore is unavailable while another operation is running."));
      return;
    }
    const summaries = await listSessionSummaries(this.context.workspaceRoot, {
      excludeSessionId: this.session.sessionId,
    });
    this.sessionPickerSelectionHandler = (sessionId) => {
      this.startBackgroundTask("Restore", () => this.restoreSelectedSession(sessionId));
    };
    this.sessionPickerCancelHandler = () => {};
    this.view.openSessionPicker(summaries);
  }

  private async restoreSelectedSession(sessionId: string): Promise<void> {
    this.cancelPending?.();
    try {
      const restoredSession = await loadSessionForAppend(this.context.workspaceRoot, sessionId);
      const rehydrated = rehydrateSession((await loadSession(this.context.workspaceRoot, sessionId)).events);
      const warnings = restoreRuntimeConfigOverrides(this.context, rehydrated.runtimeConfigOverrides);
      const noticeText = `Restored session ${sessionId.slice(0, 8)}.`;
      const droppedNotice = this.clearQueuedChatMessages();
      const transcript = [
        ...rehydrated.transcript,
        ...warnings.map((warning) => systemTranscriptEntry(`Session config warning: ${warning}`)),
        systemTranscriptEntry(noticeText),
        ...(droppedNotice ? [systemTranscriptEntry(droppedNotice)] : []),
      ];
      this.session = restoredSession;
      this.sessionStartedAt = Date.now();
      this.pendingSkillActivations = [];
      this.clearTaskPlanNoticeTimer();
      try {
        await restoredSession.append({ kind: "message", role: "system", text: noticeText });
      } catch (error) {
        transcript.push(systemTranscriptEntry(`Session save failed: ${formatPlainError(error)}`));
      }
      this.view.closeSessionPicker();
      this.view.reset({
        sessionId: restoredSession.sessionId,
        transcript,
        modelLabel: getModelLabel(this.context),
        taskPlan: rehydrated.taskPlan,
        status: rehydrated.status,
      });
    } catch (error) {
      this.view.closeSessionPicker();
      this.view.addEntry(systemTranscriptEntry(`Restore failed: ${formatPlainError(error)}`));
    }
  }

  private async appendStartupRuntimeEvents(events: AgentRuntimeEvent[], target?: TranscriptEntry[]): Promise<void> {
    for (const event of events) {
      const entries = runtimeEventToTranscriptEntries(event);
      if (target) {
        target.push(...entries);
      } else {
        this.view.addEntries(entries);
      }
      const payload = runtimeEventToSessionPayload(event);
      if (!payload) {
        continue;
      }
      try {
        await this.session.append(payload);
      } catch (error) {
        const warning = systemTranscriptEntry(`Session save failed: ${formatPlainError(error)}`);
        if (target) {
          target.push(warning);
        } else {
          this.view.addEntry(warning);
        }
        return;
      }
    }
  }

  private scheduleTaskPlanNoticeClear(): void {
    this.clearTaskPlanNoticeTimer();
    this.taskPlanNoticeTimer = setTimeout(() => {
      this.taskPlanNoticeTimer = undefined;
      this.view.setTaskPlanNotice(undefined);
    }, 2500);
    this.taskPlanNoticeTimer.unref?.();
  }

  private clearTaskPlanNoticeTimer(): void {
    if (this.taskPlanNoticeTimer) {
      clearTimeout(this.taskPlanNoticeTimer);
      this.taskPlanNoticeTimer = undefined;
    }
  }

  private async clearTaskPlanForNewTurn(): Promise<void> {
    const cleared = this.view.clearTaskPlan();
    if (cleared) {
      await this.persistPayloadWithWarning({
        kind: "task_plan",
        items: cleared.items,
        updatedAt: cleared.updatedAt,
      });
    }
  }

  private async persistPayloadWithWarning(
    payload: SessionEventPayload | undefined,
    warningTarget?: TranscriptEntry[]
  ): Promise<void> {
    if (!payload) {
      return;
    }
    try {
      await this.session.append(payload);
    } catch (error) {
      const warning = systemTranscriptEntry(`Session save failed: ${formatPlainError(error)}`);
      if (warningTarget) {
        warningTarget.push(warning);
      } else {
        this.view.addEntry(warning);
      }
    }
  }

  private async persistInitialTranscript(transcript: TranscriptEntry[]): Promise<void> {
    const initialEntryCount = transcript.length;
    for (let index = 0; index < initialEntryCount; index += 1) {
      const entry = transcript[index];
      if (!entry) {
        continue;
      }
      const payload = transcriptEntryToSessionPayload(entry);
      if (!payload) {
        continue;
      }
      try {
        await this.session.append(payload);
      } catch (error) {
        transcript.push(systemTranscriptEntry(`Session save failed: ${formatPlainError(error)}`));
        return;
      }
    }
  }

  private async persistRuntimeConfigWithWarning(): Promise<void> {
    await this.persistPayloadWithWarning({
      kind: "runtime_config",
      ...(this.context.runtimeConfigOverrides.activeModel === undefined
        ? {}
        : { activeModel: this.context.runtimeConfigOverrides.activeModel }),
      reasoningEffortByProvider: { ...this.context.runtimeConfigOverrides.reasoningEffortByProvider },
    });
  }

  private openManagedDialog(entry: ChoiceTranscriptEntry, handler: (action: ChoiceTranscriptAction) => void): void {
    this.dialogHandler = handler;
    this.view.setManagedDialog(true);
    this.view.addEntry(entry);
  }

  private setCancelPending(cancel: (() => void) | undefined): void {
    this.cancelPending = cancel;
    this.view.setCanCancel(cancel !== undefined);
  }

  private clearCancelPending(cancel: () => void): void {
    if (this.cancelPending === cancel) {
      this.setCancelPending(undefined);
    }
  }

  private clearInputNotices(): void {
    this.view.setTaskPlanNotice(undefined);
    this.view.setStartupHint(undefined);
    this.view.setEphemeral(undefined);
  }

  private syncHerdrState(): void {
    if (this.disposed || this.herdrBlocked) {
      return;
    }
    const snapshot = this.view.getSnapshot();
    const state: HerdrAgentState =
      snapshot.canCancel || topchesterWorkingStatuses.has(snapshot.status) ? "working" : "idle";
    void this.herdrReporter.report({ state, sessionId: this.session.sessionId });
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new Error("TUI controller is disposed");
    }
  }
}

const topchesterWorkingStatuses = new Set([
  "checking agent",
  "thinking",
  "running command",
  "loading models",
  "connecting provider",
]);

function formatBashApprovalBody(request: BashApprovalRequest): string {
  const reason = request.reason.includes(request.command) ? "This bash command is not allowed yet." : request.reason;
  return ["Command:", request.command, "", reason].join("\n");
}

function formatCurrentReasoningEffortMessage(effort: ReasoningEffort | undefined): string {
  return `Current reasoning effort: ${effort ?? "provider default"}. Values: ${reasoningEfforts.join(", ")}.`;
}

function formatReasoningEffortUsageMessage(): string {
  return `Usage: /effort <${reasoningEfforts.join("|")}> or /effort clear.`;
}
