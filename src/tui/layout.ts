import {
  CURSOR_MARKER,
  decodeKittyPrintable,
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
import { ABORT_CHOICE_VALUE } from "../agent/events.js";
import { ui } from "../cli/ui.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { renderChatMessage, userMessage, type ChatMessage, type ChatModalAction } from "./messages.js";
import {
  isDownKey,
  isEndKey,
  isEnterKey,
  isHomeKey,
  isNewLineKey,
  isPageDownKey,
  isPageUpKey,
  isTabKey,
  isUpKey,
  parseMouseWheel,
} from "./keys.js";
import { PromptHistory } from "./prompt-history.js";
import { formatKnowledgeFooterStatus, formatStatusLine } from "./status.js";
import { padLines, padThreadLine, stripAnsi } from "./text.js";

const PROMPT_VISIBLE_CONTENT_LINES = 5;
const PASTE_PREVIEW_MIN_LINES = 6;
const PASTE_PREVIEW_MIN_CHARS = 500;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export interface ChatLayoutOptions {
  exitAgent?: () => void;
  transcriptMode?: "viewport" | "inline";
}

export class ChatLayout implements Component, Focusable {
  private inputFocused = false;
  private promptValue = "";
  private promptCursor = 0;
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
  private modalActionHandler: ((action: ChatModalAction) => void) | undefined;
  private activeModalActionIndex = 0;
  private activeSlashSuggestionIndex = 0;
  private threadScrollOffset = 0;
  private pasteBuffer: string | undefined;
  private pasteCounter = 0;
  private readonly pastedContent = new Map<string, string>();
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

  setModalActionHandler(handler: ((action: ChatModalAction) => void) | undefined): void {
    this.modalActionHandler = handler;
  }

  setInputValue(value: string): void {
    this.promptValue = value;
    this.promptCursor = value.length;
    this.pastedContent.clear();
    this.pasteCounter = 0;
  }

  resetForNewSession(messages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
    this.promptValue = "";
    this.promptCursor = 0;
    this.status = "ready";
    this.knowledgeStatus = undefined;
    this.ephemeralLine = undefined;
    this.taskPlanNoticeLine = undefined;
    this.noticeLine = undefined;
    this.promptHint = undefined;
    this.taskPlan = undefined;
    this.cancelPending = undefined;
    this.modalActionHandler = undefined;
    this.activeModalActionIndex = 0;
    this.activeSlashSuggestionIndex = 0;
    this.threadScrollOffset = 0;
    this.pasteBuffer = undefined;
    this.pasteCounter = 0;
    this.pastedContent.clear();
    this.promptHistory.clear();
    this.terminal.clearScreen();
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
        case "thinking":
        case "tool_call":
        case "subagent":
        case "modal":
          return [];
      }
    });
  }

  get focused(): boolean {
    return this.inputFocused;
  }

  set focused(value: boolean) {
    this.inputFocused = value;
  }

  handleInput(data: string): void {
    if (this.handleModalInput(data)) {
      return;
    }

    if (this.cancelPending && matchesKey(data, "escape")) {
      this.cancelPending();
      return;
    }

    if (this.handleSlashSuggestionInput(data)) {
      return;
    }

    if (this.handlePromptPasteInput(data)) {
      return;
    }

    if (this.handlePromptNewLineInput(data)) {
      return;
    }

    if (this.handlePromptSubmitInput(data)) {
      return;
    }

    if (this.handleThreadScrollInput(data)) {
      return;
    }

    if (this.handlePromptVerticalCursorInput(data)) {
      return;
    }

    if (this.handlePromptHistoryInput(data)) {
      return;
    }

    this.handlePromptEditInput(data);
  }

  invalidate(): void {
    // Prompt rendering is derived from local state.
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
    const inputLines = this.promptHint
      ? [truncateToWidth(ui.label(this.promptHint), innerWidth, "…", true)]
      : this.renderPromptInputLines(innerWidth);
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
      ...inputLines.map((line, index) => `│ ${index === 0 ? prefix : "  "}${padPromptInputLine(line, innerWidth)} │`),
      bottom,
      status,
    ];
  }

  private renderPromptInputLines(innerWidth: number): string[] {
    const value = this.promptValue;

    if (!value.includes("\n")) {
      return [this.renderPromptLineWithCursor(value, this.promptCursor, innerWidth)];
    }

    const rows = this.getPromptRows(innerWidth);
    const cursorRowIndex = rows.findIndex((row) => this.promptCursor >= row.start && this.promptCursor <= row.end);
    const latestStart = Math.max(0, rows.length - PROMPT_VISIBLE_CONTENT_LINES);
    const visibleStart = cursorRowIndex === -1 ? latestStart : Math.min(Math.max(0, cursorRowIndex - 2), latestStart);
    const visibleRows = rows.slice(visibleStart, visibleStart + PROMPT_VISIBLE_CONTENT_LINES);

    return visibleRows.map((row) => {
      if (this.promptCursor >= row.start && this.promptCursor <= row.end) {
        return this.renderPromptLineWithCursor(row.text, this.promptCursor - row.start, innerWidth);
      }

      return truncateToWidth(row.text.length === 0 ? " " : row.text, innerWidth, "…", true);
    });
  }

  private getPromptRows(width: number): Array<{ text: string; start: number; end: number }> {
    const rows: Array<{ text: string; start: number; end: number }> = [];
    let offset = 0;

    for (const line of this.promptValue.split("\n")) {
      if (line.length === 0) {
        rows.push({ text: "", start: offset, end: offset });
      } else {
        for (let index = 0; index < line.length; index += width) {
          const text = line.slice(index, index + width);
          rows.push({ text, start: offset + index, end: offset + index + text.length });
        }
      }

      offset += line.length + 1;
    }

    return rows.length > 0 ? rows : [{ text: "", start: 0, end: 0 }];
  }

  private renderPromptLineWithCursor(text: string, cursor: number, width: number): string {
    const safeCursor = Math.max(0, Math.min(cursor, text.length));
    const windowStart = safeCursor >= width ? safeCursor - width + 1 : 0;
    const visibleText = text.slice(windowStart, windowStart + width);
    const visibleCursor = safeCursor - windowStart;
    const beforeCursor = visibleText.slice(0, visibleCursor);
    const cursorChar = visibleText[visibleCursor] ?? " ";
    const afterCursor = visibleText.slice(visibleCursor + cursorChar.length);
    const marker = this.inputFocused ? CURSOR_MARKER : "";

    return truncateToWidth(`${beforeCursor}${marker}\u001b[7m${cursorChar}\u001b[27m${afterCursor}`, width, "…", true);
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
      if (this.modalActionHandler) {
        this.resolveActiveModalAction(action);
        return true;
      }

      if (action.label === "Exit") {
        this.exitAgent();
        return true;
      }

      if (action.value === ABORT_CHOICE_VALUE) {
        this.addMessage({ kind: "user", text: action.label, modelContext: false });
        return true;
      }

      this.submitModalAction(action.value ?? action.label);
      return true;
    }

    if (matchesKey(data, "escape")) {
      if (this.modalActionHandler) {
        this.resolveActiveModalAction({ label: "Cancel", value: "cancel" });
        return true;
      }

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
      const prompt = this.promptHistory.previous(this.promptValue);
      if (prompt !== undefined) {
        this.promptValue = prompt;
        this.promptCursor = prompt.length;
      }
      return true;
    }

    if (isDownKey(data)) {
      const prompt = this.promptHistory.next();
      if (prompt !== undefined) {
        this.promptValue = prompt;
        this.promptCursor = prompt.length;
      }
      return true;
    }

    return false;
  }

  private handlePromptVerticalCursorInput(data: string): boolean {
    if (this.promptHint || !this.promptValue.includes("\n")) {
      return false;
    }

    if (isUpKey(data)) {
      if (this.canMovePromptCursorVertically(-1)) {
        this.movePromptCursorVertically(-1);
        return true;
      }

      if (this.promptCursor > 0) {
        this.promptCursor = this.getCurrentPromptLineStart();
        return true;
      }

      return false;
    }

    if (isDownKey(data)) {
      if (this.canMovePromptCursorVertically(1)) {
        this.movePromptCursorVertically(1);
        return true;
      }

      if (this.promptCursor < this.promptValue.length) {
        this.promptCursor = this.getCurrentPromptLineEnd();
        return true;
      }

      return false;
    }

    return false;
  }

  private canMovePromptCursorVertically(delta: -1 | 1): boolean {
    const lines = this.promptValue.split("\n");
    const current = this.getPromptLineCursor(lines);

    if (delta === -1) {
      return current.line > 0;
    }

    return current.line < lines.length - 1;
  }

  private handlePromptNewLineInput(data: string): boolean {
    if (this.promptHint || !isNewLineKey(data)) {
      return false;
    }

    this.insertPromptText("\n");
    this.promptHistory.resetBrowsing();
    return true;
  }

  private handlePromptSubmitInput(data: string): boolean {
    if (this.promptHint || !isEnterKey(data)) {
      return false;
    }

    this.submitPromptValue();
    return true;
  }

  private handlePromptPasteInput(data: string): boolean {
    if (this.promptHint) {
      return false;
    }

    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += data;
      this.flushPromptPasteBuffer();
      return true;
    }

    const startIndex = data.indexOf(BRACKETED_PASTE_START);
    if (startIndex === -1) {
      return false;
    }

    const beforePaste = data.slice(0, startIndex);
    if (beforePaste.length > 0) {
      this.insertPromptText(beforePaste);
    }

    this.pasteBuffer = data.slice(startIndex + BRACKETED_PASTE_START.length);
    this.flushPromptPasteBuffer();
    this.promptHistory.resetBrowsing();
    return true;
  }

  private flushPromptPasteBuffer(): void {
    if (this.pasteBuffer === undefined) {
      return;
    }

    const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (endIndex === -1) {
      return;
    }

    const pasted = this.pasteBuffer.slice(0, endIndex);
    const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
    this.pasteBuffer = undefined;
    this.insertPastedText(pasted);

    if (remaining.length > 0) {
      this.handleInput(remaining);
    }
  }

  private insertPastedText(text: string): void {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
    const trimmedText = normalizedText.trim();
    if (trimmedText.length === 0) {
      return;
    }

    const lineCount = trimmedText.split("\n").length;
    if (lineCount >= PASTE_PREVIEW_MIN_LINES || trimmedText.length >= PASTE_PREVIEW_MIN_CHARS) {
      this.pasteCounter += 1;
      const marker = `[Pasted #${this.pasteCounter} ${lineCount} lines ${trimmedText.length} chars]`;
      this.pastedContent.set(marker, trimmedText);
      this.insertPromptText(marker);
      return;
    }

    this.insertPromptText(normalizedText);
  }

  private insertPromptText(text: string): void {
    this.promptValue = `${this.promptValue.slice(0, this.promptCursor)}${text}${this.promptValue.slice(this.promptCursor)}`;
    this.promptCursor += text.length;
  }

  private expandPastedContent(value: string): string {
    let expanded = value;
    for (const [marker, content] of this.pastedContent) {
      expanded = expanded.split(marker).join(content);
    }
    return expanded;
  }

  private submitPromptValue(): void {
    if (this.promptValue.trim().length === 0) {
      return;
    }

    const message = this.expandPastedContent(this.promptValue).trim();
    this.addMessage(userMessage(message));
    this.promptValue = "";
    this.promptCursor = 0;
    this.pastedContent.clear();
    this.pasteCounter = 0;
    this.submitUserInput(message);
  }

  private handlePromptEditInput(data: string): boolean {
    if (this.promptHint) {
      return false;
    }

    if (matchesKey(data, "left") || data === "\u001b[D") {
      this.promptCursor = Math.max(0, this.promptCursor - 1);
      return true;
    }

    if (matchesKey(data, "right") || data === "\u001b[C") {
      this.promptCursor = Math.min(this.promptValue.length, this.promptCursor + 1);
      return true;
    }

    if (isHomeKey(data)) {
      this.promptCursor = this.getCurrentPromptLineStart();
      return true;
    }

    if (isEndKey(data)) {
      this.promptCursor = this.getCurrentPromptLineEnd();
      return true;
    }

    if (matchesKey(data, "backspace") || data === "\u007f" || data === "\b") {
      if (this.promptCursor > 0) {
        this.promptValue = `${this.promptValue.slice(0, this.promptCursor - 1)}${this.promptValue.slice(this.promptCursor)}`;
        this.promptCursor -= 1;
        this.promptHistory.resetBrowsing();
      }
      return true;
    }

    if (matchesKey(data, "delete") || data === "\u001b[3~") {
      if (this.promptCursor < this.promptValue.length) {
        this.promptValue = `${this.promptValue.slice(0, this.promptCursor)}${this.promptValue.slice(this.promptCursor + 1)}`;
        this.promptHistory.resetBrowsing();
      }
      return true;
    }

    const printable = decodeKittyPrintable(data) ?? (isPrintableInput(data) ? data : undefined);
    if (printable !== undefined) {
      this.insertPromptText(printable);
      this.promptHistory.resetBrowsing();
      return true;
    }

    return false;
  }

  private movePromptCursorVertically(delta: -1 | 1): void {
    const lines = this.promptValue.split("\n");
    const current = this.getPromptLineCursor(lines);
    const targetLine = Math.max(0, Math.min(lines.length - 1, current.line + delta));
    const targetColumn = Math.min(current.column, lines[targetLine]?.length ?? 0);
    this.promptCursor = lines.slice(0, targetLine).reduce((total, line) => total + line.length + 1, 0) + targetColumn;
  }

  private getPromptLineCursor(lines = this.promptValue.split("\n")): { line: number; column: number } {
    let offset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const end = offset + line.length;
      if (this.promptCursor <= end || lineIndex === lines.length - 1) {
        return { line: lineIndex, column: Math.max(0, this.promptCursor - offset) };
      }
      offset = end + 1;
    }

    return { line: 0, column: 0 };
  }

  private getCurrentPromptLineStart(): number {
    return this.promptValue.lastIndexOf("\n", Math.max(0, this.promptCursor - 1)) + 1;
  }

  private getCurrentPromptLineEnd(): number {
    const end = this.promptValue.indexOf("\n", this.promptCursor);
    return end === -1 ? this.promptValue.length : end;
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

    if (isEnterKey(data) && this.promptValue.trim() !== suggestions[this.activeSlashSuggestionIndex]?.value) {
      this.completeSlashSuggestion(suggestions);
      return true;
    }

    return false;
  }

  private completeSlashSuggestion(suggestions: SlashCommandSuggestion[]): void {
    this.promptValue = suggestions[this.activeSlashSuggestionIndex]?.value ?? this.promptValue;
    this.promptCursor = this.promptValue.length;
    this.promptHistory.resetBrowsing();
  }

  private getSlashSuggestions(): SlashCommandSuggestion[] {
    return getSlashCommandSuggestions(this.promptValue);
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

  private resolveActiveModalAction(action: ChatModalAction): void {
    const handler = this.modalActionHandler;

    this.modalActionHandler = undefined;
    this.dismissActiveModal();
    handler?.(action);
  }

  dismissActiveModal(): void {
    const index = this.getActiveModalIndex();

    if (index >= 0) {
      this.messages.splice(index, 1);
    }

    this.activeModalActionIndex = 0;
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

function padPromptInputLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - stripAnsi(line).length))}`;
}

function isPrintableInput(data: string): boolean {
  if (data.length === 0) {
    return false;
  }

  return [...data].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127 && (code < 128 || code > 159);
  });
}
