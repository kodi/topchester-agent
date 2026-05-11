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
import { checkAgentReady } from "../agent/health.js";
import { type AppContext } from "../app/context.js";
import { ui } from "../cli/ui.js";
import { type ModelPurpose } from "../model/index.js";
import { agentMessage, renderChatMessage, systemMessage, userMessage, type ChatMessage } from "./messages.js";

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
    const tui = new TUI(terminal, true);
    const app = new ChatLayout(terminal, messages, folderName, modelLabel);

    tui.addChild(app);
    tui.setFocus(app);
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        tui.stop();
        process.exit(0);
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

    tui.requestRender();
  }
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
    for (const [purpose, modelRef] of Object.entries(assignments)) {
      lines.push(`  ${purpose}: ${modelRef}`);
    }
  }

  if (Object.keys(providers).length === 0) {
    lines.push(`${ui.label("providers")}: none configured`);
  } else {
    lines.push(`${ui.label("providers")}:`);
    for (const [providerId, provider] of Object.entries(providers)) {
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      lines.push(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }

  lines.push("");
  lines.push("Ask Topchester what you want to change. Agent loop is not wired yet.");

  return lines.map(systemMessage);
}

function renderStaticLayout(messages: ChatMessage[], folderName = "", modelLabel = ""): string {
  const threadLines = messages.flatMap(renderChatMessage);
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

class ChatLayout implements Component, Focusable {
  private readonly input = new Input();
  private status = "ready";
  private ephemeralLine: string | undefined;
  private promptHint: string | undefined;
  private cancelPending: (() => void) | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly messages: ChatMessage[],
    private readonly folderName: string,
    private readonly modelLabel: string
  ) {
    this.input.onSubmit = (value) => {
      if (value.trim().length > 0) {
        this.addMessage(userMessage(value));
        this.addMessage(agentMessage("chat is not wired yet"));
        this.input.setValue("");
      }
    };
  }

  addMessage(message: ChatMessage): void {
    this.messages.push(message);
  }

  setStatus(status: string): void {
    this.status = status;
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

    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const footerLines = this.renderPrompt(safeWidth);
    const threadHeight = Math.max(1, this.terminal.rows - footerLines.length);
    const threadLines = this.renderThread(safeWidth).slice(-threadHeight);

    return [...padLines(threadLines, threadHeight, safeWidth), ...footerLines];
  }

  private renderThread(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);

    const lines = this.messages.flatMap(renderChatMessage);

    if (this.ephemeralLine) {
      lines.push(this.ephemeralLine);
    }

    return lines.flatMap((line) => {
      if (line.length === 0) {
        return [padThreadLine("", innerWidth, width)];
      }

      return wrapTextWithAnsi(line, innerWidth).map((wrappedLine) => padThreadLine(wrappedLine, innerWidth, width));
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

    return [top, `│ ${prefix}${inputLine} │`, bottom, status];
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

function getModelLabel(context: AppContext): string {
  const purpose = context.config.models?.defaultPurpose ?? "agent.primary";
  const modelRef =
    context.config.models?.assignments?.[purpose as ModelPurpose] ?? context.config.models?.assignments?.fallback;

  if (!modelRef) {
    return "not set";
  }

  const separatorIndex = modelRef.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === modelRef.length - 1) {
    return modelRef;
  }

  return `${modelRef.slice(separatorIndex + 1)} [${modelRef.slice(0, separatorIndex)}]`;
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

interface BusyIndicatorOptions {
  status: string;
  promptHint: string;
  activities: string[];
}

class BusyIndicator {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | undefined;
  private index = 0;
  private ticks = 0;

  constructor(
    private readonly app: ChatLayout,
    private readonly tui: TUI,
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
