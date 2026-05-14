import {
  Input,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Terminal,
} from "@earendil-works/pi-tui";
import { getSlashCommandSuggestions, type SlashCommandSuggestion } from "../agent/commands.js";
import { type ConversationTurn } from "../agent/conversation.js";
import {
  detectTaskPlanChange,
  formatTaskPlanForTui,
  type TaskPlanChangeKind,
  type TaskPlanState,
} from "../agent/task-plan.js";
import { ui } from "../cli/ui.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { renderChatMessage, userMessage, type ChatMessage } from "./messages.js";
import {
  isDownKey,
  isEndKey,
  isEnterKey,
  isHomeKey,
  isPageDownKey,
  isPageUpKey,
  isTabKey,
  isUpKey,
  parseMouseWheel,
} from "./keys.js";
import { PromptHistory } from "./prompt-history.js";
import { formatKnowledgeFooterStatus, formatStatusLine } from "./status.js";
import { padLines, padThreadLine, stripAnsi } from "./text.js";

export interface ChatLayoutOptions {
  exitAgent?: () => void;
  transcriptMode?: "viewport" | "inline";
}

export class ChatLayout implements Component, Focusable {
  private readonly input = new Input();
  private status = "ready";
  private knowledgeStatus: string | undefined;
  private ephemeralLine: string | undefined;
  private taskPlanNoticeLine: string | undefined;
  private noticeLine: string | undefined;
  private promptHint: string | undefined;
  private taskPlan: TaskPlanState | undefined;
  private cancelPending: (() => void) | undefined;
  private submitMessage: ((message: string) => void) | undefined;
  private submitCommand: ((command: string) => void) | undefined;
  private activeModalActionIndex = 0;
  private activeSlashSuggestionIndex = 0;
  private threadScrollOffset = 0;
  private readonly promptHistory = new PromptHistory();
  private readonly exitAgent: () => void;
  private readonly transcriptMode: "viewport" | "inline";

  constructor(
    private readonly terminal: Terminal,
    private readonly messages: ChatMessage[],
    private readonly folderName: string,
    private readonly modelLabel: string,
    options: (() => void) | ChatLayoutOptions = {}
  ) {
    this.exitAgent = typeof options === "function" ? options : (options.exitAgent ?? (() => {}));
    this.transcriptMode = typeof options === "function" ? "viewport" : (options.transcriptMode ?? "viewport");
    this.input.onSubmit = (value) => {
      if (value.trim().length > 0) {
        const message = value.trim();
        this.addMessage(userMessage(message));
        this.input.setValue("");
        this.submitUserInput(message);
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

  setKnowledgeStatus(status: KnowledgeStatus): void {
    this.knowledgeStatus = formatKnowledgeFooterStatus(status);
  }

  setTaskPlan(plan: TaskPlanState | undefined): TaskPlanChangeKind {
    const change = detectTaskPlanChange(this.taskPlan, plan);

    this.taskPlan = plan && plan.items.length > 0 ? plan : undefined;

    return change;
  }

  setTaskPlanNotice(line: string | undefined): void {
    this.taskPlanNoticeLine = line;
  }

  clearTaskPlan(now: Date = new Date()): TaskPlanState | undefined {
    if (!this.taskPlan) {
      return undefined;
    }

    const cleared = { items: [], updatedAt: now.toISOString() };

    this.taskPlan = undefined;
    this.taskPlanNoticeLine = undefined;

    return cleared;
  }

  isReady(): boolean {
    return this.status === "ready";
  }

  setEphemeralLine(line: string | undefined): void {
    this.ephemeralLine = line;
  }

  setNoticeLine(line: string | undefined): void {
    this.noticeLine = line;
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

  getConversationTurns(): ConversationTurn[] {
    return this.messages.flatMap((message): ConversationTurn[] => {
      switch (message.kind) {
        case "user":
          return message.modelContext === false ? [] : [{ role: "user", text: message.text }];
        case "agent":
          return message.text === "ready" || message.modelContext === false
            ? []
            : [{ role: "assistant", text: message.text }];
        case "system":
        case "tool_call":
        case "modal":
          return [];
      }
    });
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

    if (this.handlePromptHistoryInput(data)) {
      return;
    }

    const previousInput = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== previousInput) {
      this.promptHistory.resetBrowsing();
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const footerLines = this.getActiveModal() ? this.renderModalHelp(safeWidth) : this.renderPrompt(safeWidth);
    const threadHeight = Math.max(1, this.terminal.rows - footerLines.length);
    const allThreadLines = this.renderThread(safeWidth);

    if (this.transcriptMode === "inline") {
      this.threadScrollOffset = 0;
      const threadLines =
        allThreadLines.length < threadHeight ? padLines(allThreadLines, threadHeight, safeWidth) : allThreadLines;

      return [...threadLines, ...footerLines];
    }

    const maxScrollOffset = Math.max(0, allThreadLines.length - threadHeight);
    this.threadScrollOffset = Math.min(this.threadScrollOffset, maxScrollOffset);
    const end = allThreadLines.length - this.threadScrollOffset;
    const start = Math.max(0, end - threadHeight);
    const threadLines = allThreadLines.slice(start, end);

    return [...padLines(threadLines, threadHeight, safeWidth), ...footerLines];
  }

  private renderThread(width: number): string[] {
    const innerWidth = Math.max(1, width);

    const activeModalIndex = this.getActiveModalIndex();
    const lines = this.messages.flatMap((message, index) => {
      const messageLines = renderChatMessage(message, {
        selectedActionIndex: index === activeModalIndex ? this.activeModalActionIndex : undefined,
        width: innerWidth,
      });
      const spacer = index === this.messages.length - 1 ? [] : [padThreadLine("", width)];

      return [...this.renderThreadMessageLines(messageLines, innerWidth, width, message.kind === "user"), ...spacer];
    });

    if (this.ephemeralLine) {
      lines.push(...this.renderThreadMessageLines([` ${this.ephemeralLine}`], innerWidth, width, false));
    }

    if (this.taskPlanNoticeLine) {
      lines.push(...this.renderThreadMessageLines([` ${this.taskPlanNoticeLine}`], innerWidth, width, false));
    }

    if (this.noticeLine) {
      lines.push(...this.renderThreadMessageLines([` ${this.noticeLine}`], innerWidth, width, false));
    }

    return lines;
  }

  private renderThreadMessageLines(lines: string[], innerWidth: number, width: number, highlight: boolean): string[] {
    return lines.flatMap((line) => {
      const styleLine = (value: string) => (highlight ? ui.softBackground(colorUserMessageBorder(value)) : value);

      if (line.length === 0) {
        return [styleLine(padThreadLine("", width))];
      }

      return wrapTextWithAnsi(line, innerWidth).map((wrappedLine) => styleLine(padThreadLine(wrappedLine, width)));
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
    const statusInnerWidth = Math.max(1, width - 2);
    const status = truncateToWidth(
      ` ${formatStatusLine(this.folderName, this.modelLabel, this.status, this.knowledgeStatus, statusInnerWidth)} `,
      width,
      "…",
      true
    );

    return [
      ...this.renderSlashSuggestions(width),
      ...this.renderTaskPlan(width),
      top,
      `│ ${prefix}${inputLine} │`,
      bottom,
      status,
    ];
  }

  private renderTaskPlan(width: number): string[] {
    if (!this.taskPlan) {
      return [];
    }

    return formatTaskPlanForTui(this.taskPlan, Math.max(1, width));
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
    const statusInnerWidth = Math.max(1, width - 4);
    const status = formatStatusLine(
      this.folderName,
      this.modelLabel,
      this.status,
      this.knowledgeStatus,
      statusInnerWidth
    );

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

      this.submitModalAction(action.value ?? action.label);
      return true;
    }

    if (matchesKey(data, "escape")) {
      this.addMessage(userMessage("Cancel"));
      return true;
    }

    return false;
  }

  private handleThreadScrollInput(data: string): boolean {
    if (this.transcriptMode === "inline") {
      return false;
    }

    const pageSize = Math.max(1, Math.floor(this.terminal.rows / 2));
    const wheel = parseMouseWheel(data);

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

  private handlePromptHistoryInput(data: string): boolean {
    if (this.promptHint) {
      return false;
    }

    if (isUpKey(data)) {
      const prompt = this.promptHistory.previous(this.input.getValue());
      if (prompt !== undefined) {
        this.input.setValue(prompt);
      }
      return true;
    }

    if (isDownKey(data)) {
      const prompt = this.promptHistory.next();
      if (prompt !== undefined) {
        this.input.setValue(prompt);
      }
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
    this.promptHistory.resetBrowsing();
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

  private submitModalAction(message: string): void {
    this.addMessage(userMessage(message));
    this.submitUserInput(message);
  }

  private submitUserInput(message: string): void {
    this.setTaskPlanNotice(undefined);
    this.promptHistory.add(message);
    if (message.startsWith("/")) {
      this.submitCommand?.(message);
    } else {
      this.submitMessage?.(message);
    }
  }
}

function colorUserMessageBorder(line: string): string {
  return line.replace("▌", ui.modelInline("▌"));
}

function renderInputWithoutPrompt(input: Input, width: number): string {
  return (input.render(width + 2)[0] ?? "").replace(/^> /, "");
}
