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
import { ui } from "../cli/ui.js";
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
import { formatStatusLine } from "./status.js";
import { padLines, padThreadLine, stripAnsi } from "./text.js";

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

  getConversationTurns(): ConversationTurn[] {
    return this.messages.flatMap((message): ConversationTurn[] => {
      if (message.kind === "user") {
        return [{ role: "user", text: message.text }];
      }

      if (message.kind === "agent" && message.text !== "ready") {
        return [{ role: "assistant", text: message.text }];
      }

      return [];
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

  private submitModalAction(message: string): void {
    this.addMessage(userMessage(message));
    this.submitUserInput(message);
  }

  private submitUserInput(message: string): void {
    if (message.startsWith("/")) {
      this.submitCommand?.(message);
    } else {
      this.submitMessage?.(message);
    }
  }
}

function renderInputWithoutPrompt(input: Input, width: number): string {
  return (input.render(width + 2)[0] ?? "").replace(/^> /, "");
}
