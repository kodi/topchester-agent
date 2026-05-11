import {
  Input,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TUI,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Terminal,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { executeSlashCommand, getSlashCommandSuggestions, type SlashCommandSuggestion } from "../agent/commands.js";
import { checkAgentReady } from "../agent/health.js";
import { executeToolCall, parseToolCall, type ToolResult } from "../agent/tools.js";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../knowledge/status.js";
import { type ModelPurpose } from "../model/index.js";
import {
  agentMessage,
  modalMessage,
  renderChatMessage,
  systemMessage,
  userMessage,
  type ChatMessage,
} from "./messages.js";

export interface TuiShell {
  render(): Promise<void>;
}

export class TopchesterTuiShell implements TuiShell {
  constructor(private readonly context: AppContext) {}

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
      const result = await checkAgentReady(this.context.modelGateway, abortController.signal);

      if (result === "ready") {
        app.addMessage(agentMessage("ready"));
        app.setStatus("ready");
      } else if (result === "timed-out") {
        app.addMessage(systemMessage("Agent is taking a while, so I skipped the startup check."));
        app.setStatus("ready");
      } else {
        app.addMessage(systemMessage("Agent did not say it was ready."));
        app.setStatus("ready");
      }
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
      this.checkKnowledgeBase(app);
    }

    tui.requestRender();
  }

  private checkKnowledgeBase(app: ChatLayout): void {
    const status = getKnowledgeStatus(this.context.workspaceRoot);

    for (const message of getKnowledgeStatusMessages(status, this.context.devFlags)) {
      app.addMessage(message);
    }
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
      const startedAt = Date.now();
      const result = await this.context.modelGateway.generateText({
        purpose: "agent.primary",
        system: getChatSystemPrompt(),
        prompt: app.getConversationPrompt(message),
        abortSignal: abortController.signal,
      });
      const durationMs = Date.now() - startedAt;
      const meta = formatAgentMessageMeta(result.modelId, durationMs);
      const toolCall = parseToolCall(result.text);

      if (toolCall) {
        app.addMessage(systemMessage(formatToolCallMessage(toolCall)));
        const toolResult = await executeToolCall(this.context.workspaceRoot, toolCall);
        const finalStartedAt = Date.now();
        const finalResult = await this.context.modelGateway.generateText({
          purpose: "agent.primary",
          system: getChatSystemPrompt(),
          prompt: `${app.getConversationPrompt(message)}\n\n${formatToolResultForPrompt(toolResult)}\n\nAnswer the user's request using the tool result above. Do not guess.`,
          abortSignal: abortController.signal,
        });
        const finalDurationMs = durationMs + Date.now() - finalStartedAt;
        const finalMeta = formatAgentMessageMeta(finalResult.modelId, finalDurationMs);

        app.addMessage(agentMessage(finalResult.text.trim() || "I got an empty response from the model.", finalMeta));
        app.setStatus("ready");
        return;
      }

      app.addMessage(agentMessage(result.text.trim() || "I got an empty response from the model.", meta));
      app.setStatus("ready");
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
      const result = await executeSlashCommand(command, {
        workspaceRoot: this.context.workspaceRoot,
      });

      app.addMessage(systemMessage(result.messages.join("\n")));
      app.setStatus("ready");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      app.addMessage(systemMessage(`Command failed: ${errorMessage}`));
      app.setStatus("command failed");
    } finally {
      tui.requestRender();
    }
  }
}

export function getKnowledgeStatusMessages(status: KnowledgeStatus, devFlags = new Set<string>()): ChatMessage[] {
  const messages: ChatMessage[] = [
    systemMessage(
      `KB status: ${formatPathStatus(status.kbPath, status.kbExists, status.kbIsDirectory)} (${status.kbPathSource})`
    ),
  ];

  if (devFlags.has("disable-kb-check-modal")) {
    return messages;
  }

  if (!status.kbExists) {
    messages.push(
      modalMessage({
        tone: "warning",
        title: "No KB found",
        body: "Topchester needs a project knowledge base before normal coding can start.",
        actions: [{ label: "Create KB now", value: "/kb init" }, { label: "Exit" }],
      })
    );
  } else if (!status.kbIsDirectory) {
    messages.push(
      modalMessage({
        tone: "warning",
        title: "KB path is not a folder",
        body: `This path exists but is not a folder:\n${status.kbPath}`,
        actions: [{ label: "Exit" }],
      })
    );
  }

  return messages;
}

export function getStartupThreadMessages(context: AppContext): ChatMessage[] {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};
  const lines = [
    ui.heading(""),
    `${ui.label("workspace")}: ${context.workspaceRoot}`,
    `${ui.label("default model")}: ${context.config.models?.defaultPurpose ?? "agent.primary"}`,
  ];

  if (Object.keys(assignments).length === 0) {
    lines.push(`${ui.label("model assignments")}: none configured`);
  } else {
    lines.push(`${ui.label("model assignments")}:`);
    for (const [purpose, model] of Object.entries(assignments)) {
      const provider = model.provider ? ` [${model.provider}]` : "";
      lines.push(`  ${purpose}: ${model.name}${provider}`);
    }
  }

  const namedProviders = Object.entries(providers).filter(([providerId]) => providerId !== "default");

  if (namedProviders.length === 0) {
    lines.push(`${ui.label("providers")}: none configured`);
  } else {
    lines.push(`${ui.label("providers")}:`);
    if (typeof providers.default === "string") {
      lines.push(`  default: ${providers.default}`);
    }
    for (const [providerId, provider] of namedProviders) {
      if (typeof provider === "string") {
        continue;
      }
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      lines.push(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }

  lines.push("");
  lines.push("Ask Topchester what you want to change. Agent loop is not wired yet.");

  return lines.map(systemMessage);
}

function renderStaticLayout(messages: ChatMessage[], folderName = "", modelLabel = ""): string {
  const threadLines = messages.flatMap((message) => renderChatMessage(message));
  const status = formatStatusLine(folderName, modelLabel);

  return [
    ...threadLines,
    "",
    "┌──────────────────────────────────────────────────────────────────────┐",
    "│ >                                                                    │",
    "└──────────────────────────────────────────────────────────────────────┘",
    status,
  ].join("\n");
}

export function enterAlternateScreen(terminal: Pick<Terminal, "write" | "clearScreen">): void {
  terminal.write("\u001b[?1049h");
  terminal.clearScreen();
}

export function exitAlternateScreen(terminal: Pick<Terminal, "write">): void {
  terminal.write("\u001b[?1049l");
}

export class ChatLayout implements Component, Focusable {
  private readonly input = new Input();
  private status = "ready";
  private ephemeralLine: string | undefined;
  private promptHint: string | undefined;
  private cancelPending: (() => void) | undefined;
  private submitMessage: ((message: string) => void) | undefined;
  private submitCommand: ((command: string) => void) | undefined;
  private activeModalActionIndex = 0;
  private activeSlashSuggestionIndex = 0;
  private threadScrollOffset = 0;

  constructor(
    private readonly terminal: Terminal,
    private readonly messages: ChatMessage[],
    private readonly folderName: string,
    private readonly modelLabel: string,
    private readonly exitAgent: () => void = () => {}
  ) {
    this.input.onSubmit = (value) => {
      if (value.trim().length > 0) {
        const message = value.trim();
        this.addMessage(userMessage(message));
        this.input.setValue("");
        if (message.startsWith("/")) {
          this.submitCommand?.(message);
        } else {
          this.submitMessage?.(message);
        }
      }
    };
  }

  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.threadScrollOffset = 0;
    if (message.kind === "modal") {
      this.activeModalActionIndex = 0;
    }
  }

  setStatus(status: string): void {
    this.status = status;
  }

  isReady(): boolean {
    return this.status === "ready";
  }

  setEphemeralLine(line: string | undefined): void {
    this.ephemeralLine = line;
  }

  setPromptHint(hint: string | undefined): void {
    this.promptHint = hint;
  }

  setCancelPending(cancel: (() => void) | undefined): void {
    this.cancelPending = cancel;
  }

  setSubmitMessage(submit: ((message: string) => void) | undefined): void {
    this.submitMessage = submit;
  }

  setSubmitCommand(submit: ((command: string) => void) | undefined): void {
    this.submitCommand = submit;
  }

  setInputValue(value: string): void {
    this.input.setValue(value);
  }

  getConversationPrompt(latestMessage: string): string {
    const turns = this.messages.flatMap((message) => {
      if (message.kind === "user") {
        return [`User: ${message.text}`];
      }

      if (message.kind === "agent" && message.text !== "ready") {
        return [`Assistant: ${message.text}`];
      }

      return [];
    });

    if (turns.at(-1) !== `User: ${latestMessage}`) {
      turns.push(`User: ${latestMessage}`);
    }

    return turns.join("\n\n");
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.cancelPending && matchesKey(data, "escape")) {
      this.cancelPending();
      return;
    }

    if (this.handleModalInput(data)) {
      return;
    }

    if (this.handleSlashSuggestionInput(data)) {
      return;
    }

    if (this.handleThreadScrollInput(data)) {
      return;
    }

    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const footerLines = this.getActiveModal() ? this.renderModalHelp(safeWidth) : this.renderPrompt(safeWidth);
    const threadHeight = Math.max(1, this.terminal.rows - footerLines.length);
    const allThreadLines = this.renderThread(safeWidth);
    const maxScrollOffset = Math.max(0, allThreadLines.length - threadHeight);
    this.threadScrollOffset = Math.min(this.threadScrollOffset, maxScrollOffset);
    const end = allThreadLines.length - this.threadScrollOffset;
    const start = Math.max(0, end - threadHeight);
    const threadLines = allThreadLines.slice(start, end);

    return [...padLines(threadLines, threadHeight, safeWidth), ...footerLines];
  }

  private renderThread(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);

    const activeModalIndex = this.getActiveModalIndex();
    const lines = this.messages.flatMap((message, index) => {
      const messageLines = renderChatMessage(message, {
        selectedActionIndex: index === activeModalIndex ? this.activeModalActionIndex : undefined,
      });
      const spacer = index === this.messages.length - 1 ? [] : [padThreadLine("", innerWidth, width)];

      return [...this.renderThreadMessageLines(messageLines, innerWidth, width, message.kind === "user"), ...spacer];
    });

    if (this.ephemeralLine) {
      lines.push(...this.renderThreadMessageLines([this.ephemeralLine], innerWidth, width, false));
    }

    return lines;
  }

  private renderThreadMessageLines(lines: string[], innerWidth: number, width: number, highlight: boolean): string[] {
    return lines.flatMap((line) => {
      const styleLine = (value: string) => (highlight ? ui.softBackground(value) : value);

      if (line.length === 0) {
        return [styleLine(padThreadLine("", innerWidth, width))];
      }

      return wrapTextWithAnsi(line, innerWidth).map((wrappedLine) =>
        styleLine(padThreadLine(wrappedLine, innerWidth, width))
      );
    });
  }

  private renderPrompt(width: number): string[] {
    const top = `┌${"─".repeat(Math.max(0, width - 2))}┐`;
    const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;
    const prefix = "> ";
    const innerWidth = Math.max(1, width - 4 - prefix.length);
    const inputLine = this.promptHint
      ? truncateToWidth(ui.label(this.promptHint), innerWidth, "…", true)
      : truncateToWidth(renderInputWithoutPrompt(this.input, innerWidth), innerWidth, "…", true);
    const status = truncateToWidth(formatStatusLine(this.folderName, this.modelLabel, this.status), width, "…", true);

    return [...this.renderSlashSuggestions(width), top, `│ ${prefix}${inputLine} │`, bottom, status];
  }

  private renderSlashSuggestions(width: number): string[] {
    const suggestions = this.getSlashSuggestions();

    if (suggestions.length === 0 || this.promptHint) {
      return [];
    }

    this.activeSlashSuggestionIndex = Math.min(this.activeSlashSuggestionIndex, suggestions.length - 1);

    const innerWidth = Math.max(1, width - 4);
    const visibleSuggestions = suggestions.slice(0, 6);
    const lines = [
      ui.label("slash commands"),
      ...visibleSuggestions.map((suggestion, index) => {
        const marker = index === this.activeSlashSuggestionIndex ? ">" : " ";
        const text = `${marker} ${suggestion.value} — ${suggestion.description}`;

        return truncateToWidth(text, innerWidth, "…", true);
      }),
      ui.label("Tab complete · ↑↓ choose"),
    ];
    const maxLineWidth = Math.max(...lines.map(stripAnsi).map((line) => line.length), 1);
    const boxWidth = Math.min(innerWidth, maxLineWidth);
    const top = `╭${"─".repeat(boxWidth + 2)}╮`;
    const bottom = `╰${"─".repeat(boxWidth + 2)}╯`;

    return [
      top,
      ...lines.map((line) => `│ ${line}${" ".repeat(Math.max(0, boxWidth - stripAnsi(line).length))} │`),
      bottom,
    ];
  }

  private renderModalHelp(width: number): string[] {
    const help = "↑↓ navigate   Enter select   Esc cancel";
    const status = formatStatusLine(this.folderName, this.modelLabel, this.status);

    return [truncateToWidth(`  ${help}`, width, "…", true), truncateToWidth(`  ${status}`, width, "…", true)];
  }

  private handleModalInput(data: string): boolean {
    const activeModal = this.getActiveModal();

    if (!activeModal) {
      return false;
    }

    if (isUpKey(data)) {
      this.activeModalActionIndex =
        (this.activeModalActionIndex - 1 + activeModal.actions.length) % activeModal.actions.length;
      return true;
    }

    if (isDownKey(data)) {
      this.activeModalActionIndex = (this.activeModalActionIndex + 1) % activeModal.actions.length;
      return true;
    }

    if (matchesKey(data, "enter") || data === "\n" || data === "\r") {
      const action = activeModal.actions[this.activeModalActionIndex];
      if (action.label === "Exit") {
        this.exitAgent();
        return true;
      }

      this.addMessage(userMessage(action.value ?? action.label));
      this.submitMessage?.(action.value ?? action.label);
      return true;
    }

    if (matchesKey(data, "escape")) {
      this.addMessage(userMessage("Cancel"));
      return true;
    }

    return false;
  }

  private handleThreadScrollInput(data: string): boolean {
    const pageSize = Math.max(1, Math.floor(this.terminal.rows / 2));
    const wheel = parseMouseWheel(data);

    if (isUpKey(data)) {
      this.threadScrollOffset += 3;
      return true;
    }

    if (isDownKey(data)) {
      this.threadScrollOffset = Math.max(0, this.threadScrollOffset - 3);
      return true;
    }

    if (wheel === "up") {
      this.threadScrollOffset += 3;
      return true;
    }

    if (wheel === "down") {
      this.threadScrollOffset = Math.max(0, this.threadScrollOffset - 3);
      return true;
    }

    if (isPageUpKey(data)) {
      this.threadScrollOffset += pageSize;
      return true;
    }

    if (isPageDownKey(data)) {
      this.threadScrollOffset = Math.max(0, this.threadScrollOffset - pageSize);
      return true;
    }

    if (isHomeKey(data)) {
      this.threadScrollOffset = Number.MAX_SAFE_INTEGER;
      return true;
    }

    if (isEndKey(data)) {
      this.threadScrollOffset = 0;
      return true;
    }

    return false;
  }

  private handleSlashSuggestionInput(data: string): boolean {
    const suggestions = this.getSlashSuggestions();

    if (suggestions.length === 0) {
      this.activeSlashSuggestionIndex = 0;
      return false;
    }

    if (isUpKey(data)) {
      this.activeSlashSuggestionIndex = (this.activeSlashSuggestionIndex - 1 + suggestions.length) % suggestions.length;
      return true;
    }

    if (isDownKey(data)) {
      this.activeSlashSuggestionIndex = (this.activeSlashSuggestionIndex + 1) % suggestions.length;
      return true;
    }

    if (isTabKey(data)) {
      this.completeSlashSuggestion(suggestions);
      return true;
    }

    if (isEnterKey(data) && this.input.getValue().trim() !== suggestions[this.activeSlashSuggestionIndex]?.value) {
      this.completeSlashSuggestion(suggestions);
      return true;
    }

    return false;
  }

  private completeSlashSuggestion(suggestions: SlashCommandSuggestion[]): void {
    this.input.setValue(suggestions[this.activeSlashSuggestionIndex]?.value ?? this.input.getValue());
    this.input.handleInput("\u001b[F");
  }

  private getSlashSuggestions(): SlashCommandSuggestion[] {
    return getSlashCommandSuggestions(this.input.getValue());
  }

  private getActiveModal(): Extract<ChatMessage, { kind: "modal" }> | undefined {
    return this.messages[this.getActiveModalIndex()] as Extract<ChatMessage, { kind: "modal" }> | undefined;
  }

  private getActiveModalIndex(): number {
    return this.messages[this.messages.length - 1]?.kind === "modal" ? this.messages.length - 1 : -1;
  }
}

function getFolderName(path: string): string {
  return basename(path) || path;
}

function formatStatusLine(folderName: string, modelLabel: string, status = "ready"): string {
  const folder = folderName ? ` · folder: ${folderName}` : "";
  const model = modelLabel ? ` · model: ${modelLabel}` : "";

  return `${ui.label("status")}: ${status}${folder}${model}`;
}

function formatPathStatus(path: string, exists: boolean, isDirectory: boolean): string {
  if (!exists) {
    return `${path} ${ui.warn("[missing]")}`;
  }

  if (!isDirectory) {
    return `${path} ${ui.error("[not a folder]")}`;
  }

  return `${path} ${ui.ok("[ok]")}`;
}

function getChatSystemPrompt(): string {
  return [
    "You are Topchester, a plain-spoken terminal coding agent. Answer the user directly and concisely.",
    "You have these tools available:",
    'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
    'grep: search text inside the workspace. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
    "Use read_file when the user asks to inspect or show a specific file.",
    "Use grep when the user asks to find text, symbols, usages, functions, classes, or files by content.",
    "Do not make up file contents or search results.",
  ].join("\n");
}

function formatToolResultForPrompt(result: ToolResult): string {
  const path = result.path ? ` ${JSON.stringify(result.path)}` : "";
  const command = result.command ? ` via ${result.command}` : "";
  const warning = result.warning ? `\nWarning: ${result.warning}` : "";

  return [`Tool result from ${result.tool}${path}${command}:${warning}`, "```", result.content, "```"].join("\n");
}

function formatToolCallMessage(call: ReturnType<typeof parseToolCall>): string {
  if (!call) {
    return "Tool call";
  }

  switch (call.tool) {
    case "read_file":
      return `Tool read_file: ${call.args.path}`;
    case "grep":
      return `Tool grep: ${call.args.pattern} in ${call.args.path ?? "."}`;
  }
}

function formatAgentMessageMeta(model: string, durationMs: number): string {
  return `${model} · ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, durationMs / 1000);

  if (totalSeconds < 10) {
    return `${formatNumber(totalSeconds, 1)} sec`;
  }

  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds)} sec`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (seconds === 0) {
    return `${minutes} min`;
  }

  return `${minutes} min ${seconds} sec`;
}

function formatNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function getModelLabel(context: AppContext): string {
  const purpose = context.config.models?.defaultPurpose ?? "agent.primary";
  const model =
    context.config.models?.assignments?.[purpose as ModelPurpose] ?? context.config.models?.assignments?.fallback;

  if (!model) {
    return "not set";
  }

  const provider = model.provider ?? context.config.models?.providers?.default;

  return typeof provider === "string" ? `${model.name} [${provider}]` : model.name;
}

function padLines(lines: string[], height: number, width: number): string[] {
  const padding = Array.from({ length: Math.max(0, height - lines.length) }, () => "");

  return [...padding, ...lines].map((line) => truncateToWidth(line, width, "…", true));
}

function padThreadLine(line: string, innerWidth: number, width: number): string {
  return truncateToWidth(` ${truncateToWidth(line, innerWidth, "…", true)} `, width, "…", true);
}

function renderInputWithoutPrompt(input: Input, width: number): string {
  return (input.render(width + 2)[0] ?? "").replace(/^> /, "");
}

function isUpKey(data: string): boolean {
  return matchesKey(data, "up") || data === "\u001b[A";
}

function isDownKey(data: string): boolean {
  return matchesKey(data, "down") || data === "\u001b[B";
}

function isEnterKey(data: string): boolean {
  return matchesKey(data, "enter") || data === "\n" || data === "\r";
}

function isTabKey(data: string): boolean {
  return matchesKey(data, "tab") || data === "\t";
}

function isPageUpKey(data: string): boolean {
  return data === "\u001b[5~";
}

function isPageDownKey(data: string): boolean {
  return data === "\u001b[6~";
}

function isHomeKey(data: string): boolean {
  return matchesKey(data, "home") || data === "\u001b[H" || data === "\u001b[1~";
}

function isEndKey(data: string): boolean {
  return matchesKey(data, "end") || data === "\u001b[F" || data === "\u001b[4~";
}

function parseMouseWheel(data: string): "up" | "down" | undefined {
  const sgrMatch = data.match(new RegExp(`^${escapeRegex("\u001b")}${escapeRegex("[<")}(\\d+);\\d+;\\d+M$`));
  if (sgrMatch) {
    return getWheelDirection(Number(sgrMatch[1]));
  }

  if (data.startsWith("\u001b[M") && data.length >= 6) {
    return getWheelDirection(data.charCodeAt(3) - 32);
  }

  return undefined;
}

function getWheelDirection(button: number): "up" | "down" | undefined {
  if ((button & 64) !== 64) {
    return undefined;
  }

  return (button & 1) === 0 ? "up" : "down";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAnsi(text: string): string {
  let plain = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m") {
        index += 1;
      }
      continue;
    }

    plain += text[index];
  }

  return plain;
}

export interface BusyIndicatorOptions {
  status: string;
  promptHint: string;
  activities: string[];
}

interface RenderRequester {
  requestRender(): void;
}

export class BusyIndicator {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | undefined;
  private index = 0;
  private ticks = 0;

  constructor(
    private readonly app: ChatLayout,
    private readonly tui: RenderRequester,
    private readonly options: BusyIndicatorOptions
  ) {}

  start(): void {
    this.app.setStatus(this.options.status);
    this.app.setPromptHint(this.options.promptHint);
    this.render();
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.ticks += 1;
      this.render();
      this.tui.requestRender();
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.app.setPromptHint(undefined);
    this.app.setEphemeralLine(undefined);
  }

  private render(): void {
    const activityIndex = Math.floor(this.ticks / 15) % this.options.activities.length;
    this.app.setEphemeralLine(`${this.frames[this.index]} ${this.options.activities[activityIndex]}`);
  }
}
