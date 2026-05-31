import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { formatTaskPlanNotice, type TaskPlanState } from "../agent/task-plan.js";
import {
  TopchesterAgentRuntime,
  type AgentRuntime,
  type BashApprovalDecision,
  type BashApprovalRequest,
} from "../agent/runtime/index.js";
import { createModelGatewayFromConfig, type AppContext } from "../app/context.js";
import {
  addGlobalModelChoices,
  configureOpenRouterGlobalProvider,
  formatModelRef,
  getConfiguredModelChoices,
  loadTopchesterConfig,
  setGlobalDefaultModel,
} from "../config/index.js";
import { fallbackOpenRouterStarterChoices, selectOpenRouterStarterChoices } from "../model/openrouter.js";
import { type SessionEventPayload } from "../session/events.js";
import { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";
import { createSession, type SessionHandle } from "../session/store.js";
import {
  createSkillsService,
  formatSkillActivationNotice,
  formatSkillActivationPrompt,
  type LoadedSkill,
  type SkillActivation,
  type SkillsService,
} from "../skills/index.js";
import { BusyIndicator } from "./busy.js";
import { formatPlainError } from "./errors.js";
import { createExitConfirmationInputListener } from "./exit-confirmation.js";
import { ChatLayout } from "./layout.js";
import { type ChatMessage, systemMessage } from "./messages.js";
import {
  fetchOpenRouterChoicesWithFallback,
  filterOpenRouterChoices,
  formatHomeRelativePath,
  formatModelPickerLabel,
} from "./model-picker.js";
import { renderRuntimeEvent } from "./runtime-events.js";
import { persistMessagesWithWarning, slashCommandToSessionPayload } from "./session-persistence.js";
import {
  createBusyReasoningSink,
  formatAgentCheckSetupHint,
  getSlashCommandActivities,
  getSlashCommandArgs,
  isConnectCommand,
  isModelCommand,
  isNewSessionCommand,
  isStreamReasoningEnabledByEnv,
  persistBashApproval,
  printExitBanner,
} from "./shell-helpers.js";
import {
  createSkillInspectActions,
  createSkillsOverlayActions,
  filterSkillsForOverlay,
  formatSkillInspectBody,
  formatSkillsOverlayBody,
  SKILL_OVERLAY_BACK_VALUE,
  SKILL_OVERLAY_CLOSE_VALUE,
  SKILL_OVERLAY_RELOAD_VALUE,
} from "./skills-overlay.js";
import {
  getFolderName,
  getModelLabel,
  getStartupThreadMessages,
  renderStaticLayout,
  STARTUP_PROMPT_HINT,
} from "./status.js";

export { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";
export { createExitConfirmationInputListener, type ExitConfirmationOptions } from "./exit-confirmation.js";
export { formatHomeRelativePath, formatModelPickerLabel } from "./model-picker.js";
export {
  chatMessageToSessionPayload,
  persistMessagesWithWarning,
  slashCommandToSessionPayload,
} from "./session-persistence.js";
export { formatDuration, isStreamReasoningEnabledByEnv, printExitBanner } from "./shell-helpers.js";

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
  private knowledgeStatusTimer: ReturnType<typeof setInterval> | undefined;
  private readonly skillsService: SkillsService;
  private pendingSkillActivations: LoadedSkill[] = [];

  constructor(
    private readonly context: AppContext,
    runtime?: AgentRuntime,
    private readonly options: TuiShellOptions = {}
  ) {
    this.runtime = runtime ?? new TopchesterAgentRuntime(context);
    this.session = options.session;
    this.skillsService = createSkillsService({ workspaceRoot: context.workspaceRoot });
  }

  /**
   * --------------------------------------------
   * Main render loop for the TUI shell.
   * --------------------------------------------
   * @returns
   */
  async render(): Promise<void> {
    this.sessionStartedAt = Date.now();
    const session = this.options.session ?? (await createSession(this.context.workspaceRoot));
    this.session = session;
    const isResumed = this.options.session !== undefined;

    const messages = this.options.initialMessages ?? getStartupThreadMessages(this.context);
    if (!isResumed) {
      await persistMessagesWithWarning(session, messages, messages);
    }
    await this.appendStartupRuntimeEvents(
      session,
      messages,
      (await this.runtime.runSessionStartHooks?.(session, { isResumed })) ?? []
    );
    await this.appendStartupRuntimeEvents(session, messages, (await this.runtime.checkProjectInstructions?.()) ?? []);
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
      this.stopKnowledgeStatusRefresh();
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
    if (!isResumed) {
      app.setStartupHintLine(STARTUP_PROMPT_HINT);
    }
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
    this.startKnowledgeStatusRefresh(app, tui);
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
        const setupHint = formatAgentCheckSetupHint(message, this.context);
        app.addMessage(systemMessage(`Agent check failed: ${message}${setupHint ? `\n${setupHint}` : ""}`));
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
      const pendingSkillActivations = this.pendingSkillActivations.splice(0);
      const modelMessage =
        pendingSkillActivations.length > 0
          ? formatSkillActivationPrompt(pendingSkillActivations.map((skill) => ({ skill, instruction: message })))
          : message;
      const conversation =
        modelMessage === message ? app.getConversationTurns() : app.getConversationTurns().slice(0, -1);

      for await (const event of this.runtime.submitMessageStream(conversation, modelMessage, abortController.signal, {
        onReasoning: reasoningDisplay?.sink,
        session: this.session,
        requestBashApproval: (request) => this.requestBashApproval(app, tui, busy, request, abortController.signal),
      })) {
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

  private requestBashApproval(
    app: ChatLayout,
    tui: TUI,
    busy: BusyIndicator,
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
            void persistBashApproval(this.context, request.command)
              .then(() => settle("allow_repo"))
              .catch((error: unknown) => {
                app.addMessage(systemMessage(`Could not save bash approval: ${formatPlainError(error)}`));
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
        title: "Run bash command?",
        body: `${request.command}\n\n${request.reason}`,
        actions: [
          { label: "Run once", value: "run_once" },
          {
            label: "Always allow exact command this session",
            value: "allow_session",
          },
          {
            label: "Always allow exact command for this repo",
            value: "allow_repo",
          },
          { label: "Cancel", value: "cancel" },
        ],
      });
      busy.setActivity("Waiting for bash approval...");
      tui.requestRender();
    });
  }

  private async submitSlashCommand(app: ChatLayout, tui: TUI, command: string): Promise<void> {
    const skillActivation = await this.resolveSkillActivationCommand(command);
    if (skillActivation) {
      await this.submitSkillActivationCommand(app, tui, command, skillActivation);
      return;
    }

    if (this.isSkillsOverlayCommand(command)) {
      await this.clearTaskPlanForNewTurn(app);
      await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));
      await this.showSkillsOverlay(app, tui, this.getSkillsOverlayFilter(command));
      return;
    }

    if (isNewSessionCommand(command)) {
      await this.startNewSession(app, tui);
      return;
    }

    if (isConnectCommand(command)) {
      await this.submitConnectCommand(app, tui, command);
      return;
    }

    if (isModelCommand(command)) {
      await this.submitModelCommand(app, tui, command);
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

  private async submitSkillActivationCommand(
    app: ChatLayout,
    tui: TUI,
    command: string,
    activation: SkillActivation
  ): Promise<void> {
    await this.clearTaskPlanForNewTurn(app);
    await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));

    const hasInstruction = activation.instruction.trim().length > 0;
    app.addMessage(systemMessage(formatSkillActivationNotice(activation.skill.name, hasInstruction)));

    if (!hasInstruction) {
      this.pendingSkillActivations.push(activation.skill);
      tui.requestRender();
      return;
    }

    const busy = new BusyIndicator(app, tui, {
      status: "thinking",
      promptHint: "press Esc to stop",
      activities: ["Loading skill...", "Calling model...", "Writing response..."],
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
      const conversation = app.getConversationTurns().slice(0, -1);
      for await (const event of this.runtime.submitMessageStream(
        conversation,
        formatSkillActivationPrompt([activation]),
        abortController.signal,
        {
          onReasoning: reasoningDisplay?.sink,
          session: this.session,
          requestBashApproval: (request) => this.requestBashApproval(app, tui, busy, request, abortController.signal),
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

  private async resolveSkillActivationCommand(command: string): Promise<SkillActivation | undefined> {
    const parts = command.trim().slice(1).split(/\s+/u).filter(Boolean);
    const name = parts[0]?.toLowerCase();

    if (
      !name ||
      name === "skills" ||
      name === "kb" ||
      isNewSessionCommand(command) ||
      isConnectCommand(command) ||
      isModelCommand(command)
    ) {
      return undefined;
    }

    if (name === "skill") {
      const skillName = parts[1];
      if (!skillName) {
        return undefined;
      }

      return {
        skill: await this.skillsService.viewSkill(skillName),
        instruction: parts.slice(2).join(" "),
      };
    }

    try {
      return {
        skill: await this.skillsService.viewSkill(name),
        instruction: parts.slice(1).join(" "),
      };
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

  private async showSkillsOverlay(app: ChatLayout, tui: TUI, query = ""): Promise<void> {
    const skills = await this.skillsService.listSkills();
    const visibleSkills = filterSkillsForOverlay(skills.active, query);

    app.setModalActionHandler((action) => {
      const value = action.value;

      if (value === SKILL_OVERLAY_CLOSE_VALUE || value === "cancel") {
        tui.requestRender();
        return;
      }

      if (value === SKILL_OVERLAY_RELOAD_VALUE) {
        this.skillsService.reload();
        this.startBackgroundTask(app, tui, "Skills", () => this.showSkillsOverlay(app, tui, query));
        return;
      }

      if (value?.startsWith("inspect:")) {
        this.startBackgroundTask(app, tui, "Skills", () =>
          this.showSkillInspectOverlay(app, tui, value.slice(8), query)
        );
      }
    });
    app.addMessage({
      kind: "modal",
      tone: "info",
      title: query ? `Skills: ${query}` : "Skills",
      body: formatSkillsOverlayBody(skills, visibleSkills),
      actions: createSkillsOverlayActions(visibleSkills),
    });
    tui.requestRender();
  }

  private async showSkillInspectOverlay(app: ChatLayout, tui: TUI, skillName: string, query = ""): Promise<void> {
    const skill = await this.skillsService.viewSkill(skillName);

    app.setModalActionHandler((action) => {
      const value = action.value;

      if (value === SKILL_OVERLAY_CLOSE_VALUE || value === "cancel") {
        tui.requestRender();
        return;
      }

      if (value === SKILL_OVERLAY_BACK_VALUE) {
        this.startBackgroundTask(app, tui, "Skills", () => this.showSkillsOverlay(app, tui, query));
        return;
      }

      if (value?.startsWith("activate:")) {
        this.pendingSkillActivations.push(skill);
        app.addMessage(systemMessage(formatSkillActivationNotice(skill.name, false)));
        tui.requestRender();
      }
    });
    app.addMessage({
      kind: "modal",
      tone: "info",
      title: skill.name,
      body: formatSkillInspectBody(skill),
      actions: createSkillInspectActions(skill),
    });
    tui.requestRender();
  }

  private async submitConnectCommand(app: ChatLayout, tui: TUI, command: string): Promise<void> {
    await this.clearTaskPlanForNewTurn(app);
    await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));
    const args = getSlashCommandArgs(command);

    if (args.length === 0) {
      this.showProviderPicker(app, tui);
      return;
    }

    if (args.length === 1 && args[0]?.toLowerCase() === "openrouter") {
      await this.connectOpenRouter(app, tui);
      return;
    }

    app.addMessage(systemMessage("Usage: /connect openrouter"));
    tui.requestRender();
  }

  private async submitModelCommand(app: ChatLayout, tui: TUI, command: string): Promise<void> {
    await this.clearTaskPlanForNewTurn(app);
    await this.persistPayloadWithWarning(app, slashCommandToSessionPayload(command));
    const args = getSlashCommandArgs(command);

    if (args[0]?.toLowerCase() === "all") {
      await this.showOpenRouterCatalogPicker(app, tui, args.slice(1).join(" "));
      return;
    }

    const query = args.join(" ");
    const choices = getConfiguredModelChoices(this.context.config);

    if (choices.length === 0) {
      app.addMessage(systemMessage("No model choices are set yet. Run /connect openrouter first."));
      tui.requestRender();
      return;
    }

    const exactChoice = choices.find((choice) => formatModelRef(choice) === query);
    if (exactChoice) {
      await this.selectModelChoice(app, tui, formatModelRef(exactChoice));
      return;
    }

    this.showModelPicker(app, tui, query);
  }

  private showProviderPicker(app: ChatLayout, tui: TUI): void {
    app.setModalActionHandler((action) => {
      if (action.value === "openrouter") {
        this.startBackgroundTask(app, tui, "Connect", () => this.connectOpenRouter(app, tui));
      }
    });
    app.addMessage({
      kind: "modal",
      tone: "info",
      title: "Connect provider",
      body: "OpenRouter is the first provider in V0. Topchester will use OPENROUTER_API_KEY from your environment.",
      actions: [
        { label: "OpenRouter", value: "openrouter" },
        { label: "Cancel", value: "cancel" },
      ],
    });
    tui.requestRender();
  }

  private showModelPicker(app: ChatLayout, tui: TUI, query = ""): void {
    const normalizedQuery = query.trim().toLowerCase();
    const currentModel = getModelLabel(this.context);
    const choices = getConfiguredModelChoices(this.context.config).filter((choice) => {
      if (!normalizedQuery) {
        return true;
      }

      const ref = formatModelRef(choice).toLowerCase();
      return ref.includes(normalizedQuery) || choice.name.toLowerCase().includes(normalizedQuery);
    });

    if (choices.length === 0) {
      app.addMessage(systemMessage("No model choices matched. Use /model all to browse OpenRouter models."));
      tui.requestRender();
      return;
    }

    app.setModalActionHandler((action) => {
      const value = action.value;
      if (value?.startsWith("model:")) {
        this.startBackgroundTask(app, tui, "Model", () => this.selectModelChoice(app, tui, value.slice(6)));
      }
    });
    app.addMessage({
      kind: "modal",
      tone: "info",
      title: "Choose model",
      body: `Current: ${currentModel}`,
      actions: [
        ...choices.map((choice) => {
          const ref = formatModelRef(choice);
          return { label: formatModelPickerLabel(ref), value: `model:${ref}` };
        }),
        { label: "Cancel", value: "cancel" },
      ],
    });
    tui.requestRender();
  }

  private async showOpenRouterCatalogPicker(app: ChatLayout, tui: TUI, query = ""): Promise<void> {
    const busy = new BusyIndicator(app, tui, {
      status: "loading models",
      promptHint: "working...",
      activities: ["Asking OpenRouter for models...", "Filtering text models...", "Building model choices..."],
    });

    busy.start();
    tui.requestRender();

    try {
      const choices = await fetchOpenRouterChoicesWithFallback();
      const matches = filterOpenRouterChoices(choices, query);

      if (matches.length === 0) {
        app.addMessage(systemMessage("No OpenRouter models matched."));
        return;
      }

      app.setModalActionHandler((action) => {
        const value = action.value;
        if (value?.startsWith("model:")) {
          this.startBackgroundTask(app, tui, "Model", () => this.selectModelChoice(app, tui, value.slice(6)));
        }
      });
      app.addMessage({
        kind: "modal",
        tone: "info",
        title: "OpenRouter models",
        body: "Picking one adds it to choices and makes it the default model.",
        actions: [
          ...matches.map((choice) => ({
            label: `${formatModelPickerLabel(choice.ref)}  ${choice.description}`,
            value: `model:${choice.ref}`,
          })),
          { label: "Cancel", value: "cancel" },
        ],
      });
    } catch (error) {
      app.addMessage(systemMessage(`Could not load OpenRouter models: ${formatPlainError(error)}`));
    } finally {
      busy.stop();
      tui.requestRender();
    }
  }

  private async connectOpenRouter(app: ChatLayout, tui: TUI): Promise<void> {
    const busy = new BusyIndicator(app, tui, {
      status: "connecting provider",
      promptHint: "working...",
      activities: ["Saving OpenRouter provider...", "Loading OpenRouter models...", "Updating local choices..."],
    });

    busy.start();
    tui.requestRender();

    try {
      const providerResult = await configureOpenRouterGlobalProvider();
      let starterChoices: string[];

      try {
        starterChoices = selectOpenRouterStarterChoices(await fetchOpenRouterChoicesWithFallback());
      } catch {
        starterChoices = fallbackOpenRouterStarterChoices();
      }

      await addGlobalModelChoices(starterChoices, { prioritize: true });

      if (!this.context.config.models?.assignments?.["agent.primary"] && starterChoices[0]) {
        await setGlobalDefaultModel(starterChoices[0]);
      }

      this.reloadModelConfig(app);
      await this.refreshKnowledgeFooter(app);
      app.addMessage(
        systemMessage(
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
      this.showModelPicker(app, tui);
    } catch (error) {
      app.addMessage(systemMessage(`OpenRouter setup failed: ${formatPlainError(error)}`));
      app.setStatus("provider setup failed");
    } finally {
      busy.stop();
      tui.requestRender();
    }
  }

  private async selectModelChoice(app: ChatLayout, tui: TUI, modelRef: string): Promise<void> {
    try {
      const result = await setGlobalDefaultModel(modelRef);
      this.reloadModelConfig(app);
      await this.refreshKnowledgeFooter(app);
      app.addMessage(systemMessage(`Model set to ${modelRef}.\nconfig: ${formatHomeRelativePath(result.path)}`));
      app.setStatus("ready");
    } catch (error) {
      app.addMessage(systemMessage(`Model change failed: ${formatPlainError(error)}`));
      app.setStatus("model change failed");
    } finally {
      tui.requestRender();
    }
  }

  private reloadModelConfig(app: ChatLayout): void {
    this.context.config = loadTopchesterConfig({
      workspaceRoot: this.context.workspaceRoot,
    });
    this.context.modelGateway = createModelGatewayFromConfig(this.context.config);
    app.setModelLabel(getModelLabel(this.context));
  }

  private startKnowledgeStatusRefresh(app: ChatLayout, tui: TUI): void {
    this.stopKnowledgeStatusRefresh();

    this.knowledgeStatusTimer = setInterval(() => {
      if (!app.isReady()) {
        return;
      }

      void this.refreshKnowledgeFooter(app)
        .then(() => {
          this.context.logger.debug("Knowledge status refreshed");
          tui.requestRender();
        })
        .catch((error: unknown) => {
          this.context.logger.debug(
            {
              event: "knowledge_status_refresh_failed",
              error: formatPlainError(error),
            },
            "knowledge status refresh failed"
          );
        });
    }, 90_000);
    this.knowledgeStatusTimer.unref?.();
  }

  private stopKnowledgeStatusRefresh(): void {
    if (!this.knowledgeStatusTimer) {
      return;
    }

    clearInterval(this.knowledgeStatusTimer);
    this.knowledgeStatusTimer = undefined;
  }

  private async refreshKnowledgeFooter(app: ChatLayout): Promise<void> {
    for (const event of await this.runtime.checkKnowledgeBase()) {
      if (event.type === "knowledge_status") {
        app.setKnowledgeStatus(event.status);
      }
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
    this.pendingSkillActivations = [];

    await persistMessagesWithWarning(session, messages, messages);
    await this.appendStartupRuntimeEvents(
      session,
      messages,
      (await this.runtime.runSessionStartHooks?.(session, { isResumed: false })) ?? []
    );
    await this.appendStartupRuntimeEvents(session, messages, (await this.runtime.checkProjectInstructions?.()) ?? []);
    app.resetForNewSession(messages);
    app.setStartupHintLine(STARTUP_PROMPT_HINT);
    tui.requestRender();
    await this.checkAgent(app, tui);
  }

  private async appendStartupRuntimeEvents(
    session: SessionHandle,
    messages: ChatMessage[],
    events: AgentRuntimeEvent[]
  ): Promise<void> {
    for (const event of events) {
      messages.push(...renderRuntimeEvent(event));
      const payload = runtimeEventToSessionPayload(event);

      if (!payload) {
        continue;
      }

      try {
        await session.append(payload);
      } catch (error) {
        messages.push(systemMessage(`Session save failed: ${formatPlainError(error)}`));
        return;
      }
    }
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
