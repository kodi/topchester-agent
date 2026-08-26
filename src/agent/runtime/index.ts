import { randomUUID } from "node:crypto";
import { reloadAppBaseConfig, type AppContext } from "../../app/context.js";
import { dryRunKnowledgeCompile, filterNonCleanKnowledgeCompileResult } from "../../knowledge/compiler/index.js";
import { type KnowledgeProgressReporter } from "../../knowledge/progress.js";
import { createL1ContextPack, formatL1ContextPackForPrompt } from "../../knowledge/search.js";
import { getKnowledgeStatus, type KnowledgeStatus } from "../../knowledge/status.js";
import { LiveL1Scheduler, type LiveL1SchedulerSnapshot } from "../../knowledge/live-scheduler.js";
import { clearSyncedSessionOverlayFile } from "../../knowledge/session-overlay.js";
import { executeSlashCommand, parseSlashCommand } from "../commands.js";
import { type ConversationTurn, buildConversationPrompt } from "../conversation.js";
import {
  configuredCapacityForRoute,
  contextPolicyFromConfig,
  contextRouteKey,
  deriveContextBudget,
  resolveContextCapacity,
} from "../context/capacity.js";
import {
  compactConversationDeterministically,
  isEffectiveCompaction,
  prunePromptSegments,
} from "../context/compaction.js";
import {
  estimateTextTokens,
  fingerprintProviderRequest,
  reconcilePromptUsage,
  type RequestEstimateInput,
} from "../context/estimate.js";
import { classifyContextOverflow } from "../context/overflow.js";
import {
  conversationTurnsToProjection,
  projectionToConversationTurns,
  type ContextCompactionSnapshot,
  type InlineProjectionSegment,
  type ModelContextProjection,
} from "../context/projection.js";
import { renderPromptSegments, type PromptSegment } from "../context/prompt.js";
import { type ContextCapacity, type ContextStatus, type ContextUsageSnapshot } from "../context/types.js";
import {
  ABORT_CHOICE_VALUE,
  agentEvent,
  choiceAction,
  type AgentInstructionContextSource,
  type AgentRuntimeEvent,
} from "../events.js";
import { checkAgentReady } from "../health.js";
import {
  formatHookContextsForPrompt,
  runTopchesterHooks,
  type HookRunPayload,
  type HookRunResult,
  type RunTopchesterHooksOptions,
} from "../hooks.js";
import { resolveProjectInstructions, type ProjectInstructionContext } from "../instructions.js";
import { McpManager } from "../mcp/manager.js";
import { createMcpToolDefinitions } from "../mcp/tools.js";
import {
  createToolPermissionView,
  isToolAllowed,
  PRIMARY_AGENT_PROFILE,
  type AgentProfile,
  type ToolPermissionView,
} from "../profiles.js";
import { getChatSystemPrompt } from "../prompts.js";
import { SubagentManager } from "../subagents.js";
import { createTaskPlanController, hasOpenTaskPlan, type TaskPlanState } from "../task-plan.js";
import { type SessionHandle } from "../../session/store.js";
import { type ModelAgentResult, type ModelPurpose, type ModelReasoningSink } from "../../model/index.js";
import {
  createSkillsService,
  formatSkillActivationPrompt,
  resolveSkillMentionActivations,
} from "../../skills/index.js";
import { createRuntimeEventQueue } from "./event-queue.js";
import {
  addTokenUsageTotals,
  formatAgentMessageMeta,
  formatContinuationInstruction,
  formatInvalidToolCallRepairInstruction,
  formatOpenPlanClosureInstruction,
  formatToolCallMessage,
  formatToolResultForPrompt,
  getTextToolCallSources,
  type TurnTokenUsageTotals,
} from "./format.js";
import { formatTuiSyncStatus, getKnowledgeStatusEvents, shouldRefreshKnowledgeStatus } from "./knowledge.js";
import { formatRuntimeSteeringPrompt, type RuntimeSteeringBuffer } from "./steering.js";
import {
  generateAgentStep,
  getExecutableModelToolCalls,
  getSuppressiblePlanTodoAnswer,
  readToolProtocolEnvOverride,
  stripSuppressiblePlanTodoPrefix,
} from "./model.js";
import {
  createReadFileCache,
  executeToolCall,
  bashArgsSchema,
  isBashApprovalRequired,
  isToolErrorResult,
  parseToolCallRejection,
  type ToolCall,
  type ToolExecutionResult,
  type RuntimeToolDefinition,
  type ToolResult,
  createProfileToolCatalog,
} from "../tools.js";
import { validateBashPolicy, type BashApprovalCandidates } from "../tools/bash-policy.js";

export { getKnowledgeStatusEvents } from "./knowledge.js";
export { MutableRuntimeSteeringBuffer, type RuntimeSteeringBuffer } from "./steering.js";

const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 75;
const MAX_TOOL_CALLS_PER_TURN_ENV = "TOPCHESTER_MAX_TOOL_CALLS_PER_TURN";
const PLAN_TODO_MODE_ENV = "TOPCHESTER_PLAN_TODO_MODE";
const MAX_PLAN_TODO_UPDATES_PER_TURN_ENV = "TOPCHESTER_MAX_PLAN_TODO_UPDATES_PER_TURN";
const DEFAULT_COMPACT_MAX_PLAN_TODO_UPDATES_PER_TURN = 3;
const DEFAULT_TASK_CONCURRENCY = 3;
const STARTUP_CAPACITY_DISCOVERY_TIMEOUT_MS = 30_000;

type PlanTodoMode = "normal" | "compact";

export interface AgentRuntime {
  checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]>;
  checkKnowledgeBase(): Promise<AgentRuntimeEvent[]>;
  checkProjectInstructions?(): Promise<AgentRuntimeEvent[]>;
  runSessionStartHooks?(
    session?: SessionHandle,
    options?: { isResumed?: boolean; abortSignal?: AbortSignal }
  ): Promise<AgentRuntimeEvent[]>;
  restoreContextStatus?(status: ContextStatus | undefined, session: SessionHandle): void;
  compactConversation?(
    conversation: ConversationTurn[],
    options?: {
      focus?: string;
      reason?: "manual" | "model-switch";
      session?: SessionHandle;
      abortSignal?: AbortSignal;
    }
  ): Promise<AgentRuntimeEvent[]>;
  submitMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    options?: AgentRuntimeSubmitMessageOptions
  ): AsyncIterable<AgentRuntimeEvent>;
  submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink,
    options?: AgentRuntimeSubmitMessageOptions
  ): Promise<AgentRuntimeEvent[]>;
  submitSlashCommand(
    command: string,
    onProgress?: KnowledgeProgressReporter,
    abortSignal?: AbortSignal
  ): Promise<AgentRuntimeEvent[]>;
  getKnowledgeLiveSnapshot?(): LiveL1SchedulerSnapshot;
  subscribeKnowledgeLive?(listener: (snapshot: LiveL1SchedulerSnapshot) => void): () => void;
}

export type AgentRuntimeEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

export type UserApprovalMode = "interactive" | "auto_allow";

export interface AgentRuntimeSubmitMessageOptions {
  onReasoning?: ModelReasoningSink;
  session?: SessionHandle;
  requestBashApproval?: (request: BashApprovalRequest) => Promise<BashApprovalDecision>;
  userApprovalMode?: UserApprovalMode;
  steering?: RuntimeSteeringBuffer;
}

export interface BashApprovalRequest {
  command: string;
  workdir: string;
  reason: string;
  candidates: BashApprovalCandidates;
}

export type BashApprovalDecision = "run_once" | "allow_session" | "allow_repo" | "cancel";

export interface TopchesterAgentRuntimeOptions {
  disableL1Context?: boolean;
  profile?: AgentProfile;
  parentPermissions?: ToolPermissionView;
  session?: SessionHandle;
  liveL1Scheduler?: LiveL1Scheduler;
}

interface SessionTurnTiming {
  turnId: string;
  startedAt: number;
  logger: AppContext["logger"];
  record(category: "setup" | "approval", phase: string, phaseStartedAt: number): void;
}

interface HookModelPayload {
  model_purpose: ModelPurpose;
  model_provider: string;
  model_id: string;
  model_ref: string;
  model: {
    purpose: ModelPurpose;
    providerId: string;
    modelId: string;
    ref: string;
  };
}

function createSessionTurnTiming(logger: AppContext["logger"], session: SessionHandle): SessionTurnTiming {
  const turnId = randomUUID();
  const startedAt = Date.now();
  const scopedLogger =
    typeof logger.child === "function"
      ? logger.child({
          sessionId: session.sessionId,
          rootSessionId: session.metadata.rootSessionId,
          turnId,
        })
      : logger;

  return {
    turnId,
    startedAt,
    logger: scopedLogger,
    record(category, phase, phaseStartedAt) {
      scopedLogger.debug(
        {
          event: "session_phase",
          category,
          phase,
          durationMs: Date.now() - phaseStartedAt,
        },
        "session phase"
      );
    },
  };
}

function replacePromptPrefix(prompt: string, previous: string, next: string): string {
  if (prompt === previous) return next;
  if (prompt.startsWith(`${previous}\n\n`)) return `${next}${prompt.slice(previous.length)}`;
  const index = prompt.indexOf(previous);
  return index < 0 ? prompt : `${prompt.slice(0, index)}${next}${prompt.slice(index + previous.length)}`;
}

function replaceConversationInPromptSegments(segments: PromptSegment[], previous: string, next: string): void {
  const conversation = segments.find((segment) => segment.kind === "conversation");
  if (conversation) conversation.text = replacePromptPrefix(conversation.text, previous, next);
}

function appendToolContinuationSegments(
  segments: PromptSegment[],
  options: {
    calls: readonly ToolCall[];
    results: readonly ToolExecutionResult<ToolResult>[];
    modelCall: number;
    continuation: string;
    hookContexts: string[];
    steering: RuntimeSteeringBuffer | undefined;
  }
): void {
  const associationId = `model-call-${options.modelCall}:${options.calls.map((call) => call.tool).join("+")}`;
  const resultText = options.results.map((result) => formatToolResultForPrompt(result)).join("\n\n");
  const replaceable = options.results.every(
    (result) => !isToolErrorResult(result) && ["read_file", "grep", "list_files", "web_fetch"].includes(result.tool)
  );
  const firstCall = options.calls[0];
  const firstArgs = firstCall?.args as { path?: unknown; command?: unknown } | undefined;
  segments.push({
    kind: "tool_result",
    text: resultText,
    retention: replaceable ? "replaceable" : "required",
    associationId,
    metadata: {
      toolName: options.calls.map((call) => call.tool).join("+"),
      ...(typeof firstArgs?.path === "string" ? { path: firstArgs.path } : {}),
      ...(typeof firstArgs?.command === "string" ? { command: firstArgs.command } : {}),
      error: options.results.some((result) => isToolErrorResult(result)),
    },
  });
  segments.push({
    kind: "continuation",
    text: options.continuation,
    retention: "required",
    associationId,
  });
  const hookContext = formatHookContextsForPrompt("PostToolUse", options.hookContexts);
  if (hookContext) segments.push({ kind: "hook_context", text: hookContext, retention: "required" });
  const steering = options.steering?.drain()?.trim();
  if (steering) {
    segments.push({ kind: "steering", text: formatRuntimeSteeringPrompt(steering), retention: "required" });
  }
}

function projectionWithRuntimeSegments(
  projection: ModelContextProjection,
  promptSegments: readonly PromptSegment[]
): ModelContextProjection {
  const prefix = promptSegments.flatMap((segment): InlineProjectionSegment[] =>
    segment.kind === "knowledge" ? [{ kind: "inline", segmentKind: "knowledge", text: segment.text }] : []
  );
  const inline = promptSegments.flatMap((segment): InlineProjectionSegment[] => {
    if (segment.kind === "conversation" || segment.kind === "current_user" || segment.kind === "knowledge") return [];
    const segmentKind =
      segment.kind === "tool_result"
        ? "tool_result"
        : segment.kind === "hook_context"
          ? "hook_context"
          : segment.kind === "steering"
            ? "steering"
            : "continuation";
    return [
      {
        kind: "inline",
        segmentKind,
        text: segment.text,
        ...(segment.associationId ? { toolAssociationId: segment.associationId } : {}),
      },
    ];
  });
  return { ...projection, segments: [...prefix, ...projection.segments, ...inline] };
}

function formatCompactionGuidance(promptSegments: readonly PromptSegment[], hookContexts: readonly string[]): string {
  return [
    ...hookContexts,
    ...promptSegments
      .filter((segment) => segment.kind === "knowledge")
      .map((segment) => `Retain relevant knowledge-pack facts:\n${segment.text}`),
  ]
    .filter((value) => value.trim())
    .join("\n\n");
}

function chunkConversationTurns(turns: readonly ConversationTurn[], maxTokens: number): ConversationTurn[][] {
  const chunks: ConversationTurn[][] = [];
  let current: ConversationTurn[] = [];
  let currentTokens = 0;
  for (const turn of turns) {
    const tokens = estimateTextTokens(turn.text);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(turn);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkTexts(texts: readonly string[], maxTokens: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const value of texts) {
    const tokens = estimateTextTokens(value);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(value);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class TopchesterAgentRuntime implements AgentRuntime {
  private readonly taskPlan = createTaskPlanController();
  private readonly approvedBashCommands = new Set<string>();
  private readonly startedHookSessionKeys = new Set<string>();
  private activeTurnId: string | undefined;
  private readonly liveL1Scheduler: LiveL1Scheduler;
  private readonly contextUsageBySession = new Map<string, ContextUsageSnapshot>();
  private readonly contextRequestBySession = new Map<string, RequestEstimateInput>();
  private readonly contextCompactionsBySession = new Map<string, number>();
  private readonly learnedCapacityByRoute = new Map<string, ContextCapacity>();

  /**
   * Holds the shared application context for one runtime instance.
   * The runtime does not own those dependencies; it coordinates the
   * workspace, model gateway, logger, config, and task-plan state that
   * are passed in by the CLI or TUI layer.
   */
  constructor(
    private readonly context: AppContext,
    private readonly options: TopchesterAgentRuntimeOptions = {}
  ) {
    this.liveL1Scheduler =
      options.liveL1Scheduler ??
      new LiveL1Scheduler({
        workspaceRoot: context.workspaceRoot,
        getConfig: () => context.config,
        getModel: () => context.modelGateway,
        logger: context.logger,
        onSynced: (event) => clearSyncedSessionOverlayFile(context.workspaceRoot, event.path, event.hash),
      });
    if (context.config.knowledge?.live) this.liveL1Scheduler.start();
  }

  restoreContextStatus(status: ContextStatus | undefined, session: SessionHandle): void {
    const key = session.sessionId;
    this.contextRequestBySession.delete(key);
    if (!status) {
      this.contextUsageBySession.delete(key);
      this.contextCompactionsBySession.delete(key);
      return;
    }
    this.contextUsageBySession.set(key, status.usage);
    this.contextCompactionsBySession.set(key, status.compactionsThisSession);
    if (status.budget.capacity.source === "error-reported" || status.budget.capacity.source === "error-inferred") {
      this.learnedCapacityByRoute.set(contextRouteKey(status.route), status.budget.capacity);
    }
  }

  getKnowledgeLiveSnapshot(): LiveL1SchedulerSnapshot {
    return this.liveL1Scheduler.snapshot();
  }

  subscribeKnowledgeLive(listener: (snapshot: LiveL1SchedulerSnapshot) => void): () => void {
    return this.liveL1Scheduler.subscribe(listener);
  }

  /**
   * Performs the lightweight startup model check used by the interactive
   * agent before accepting work. The check is intentionally non-blocking
   * from the user's point of view: timeout and failure both produce a
   * visible status message, but the runtime still moves to ready so the
   * user can continue.
   */
  async checkAgent(abortSignal?: AbortSignal): Promise<AgentRuntimeEvent[]> {
    const [result] = await Promise.all([
      checkAgentReady(this.context.modelGateway, abortSignal),
      this.discoverStartupModelCapacity(abortSignal),
    ]);

    if (result === "ready") {
      return [agentEvent.status("ready")];
    }

    if (result === "timed-out") {
      return [
        agentEvent.systemMessage("Agent is taking a while, so I skipped the startup check."),
        agentEvent.status("ready"),
      ];
    }

    return [agentEvent.systemMessage("Agent did not say it was ready."), agentEvent.status("ready")];
  }

  private async discoverStartupModelCapacity(abortSignal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(STARTUP_CAPACITY_DISCOVERY_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

    try {
      const discovered = await this.context.modelGateway.discoverModelCapacity?.("agent.primary", signal);
      if (discovered) this.context.contextCapacityRegistry?.set(discovered.route, discovered.capacity);
    } catch (error) {
      this.context.logger.debug(
        {
          event: "startup_context_capacity_discovery_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "startup context capacity discovery failed"
      );
    }
  }

  /**
   * Builds the initial knowledge-base status events shown by the TUI.
   * This wraps the raw filesystem status with the same non-clean file count
   * used by `/kb status`, so startup messaging reflects whether project
   * knowledge is ready, missing, stale, or waiting for a sync.
   */
  async checkKnowledgeBase(): Promise<AgentRuntimeEvent[]> {
    return getKnowledgeStatusEvents(await this.getKnowledgeStatusWithNonCleanFileCount());
  }

  async checkProjectInstructions(): Promise<AgentRuntimeEvent[]> {
    const instructions = await this.resolveBaseProjectInstructions();

    if (instructions.sources.length === 0) {
      return [];
    }

    return [agentEvent.systemMessage(`Project instructions: ${instructions.sourceKeys.join(", ")}`)];
  }

  async runSessionStartHooks(
    session?: SessionHandle,
    options: { isResumed?: boolean; abortSignal?: AbortSignal } = {}
  ): Promise<AgentRuntimeEvent[]> {
    const sessionKey = session?.sessionId ?? `workspace:${this.context.workspaceRoot}`;

    if (this.startedHookSessionKeys.has(sessionKey)) {
      return [];
    }

    this.startedHookSessionKeys.add(sessionKey);

    const startedEvents: AgentRuntimeEvent[] = [];
    const result = await this.runHookEvent(
      "SessionStart",
      this.createBaseHookPayload("SessionStart", session, {
        isResumed: Boolean(options.isResumed),
        taskStartAlias: "TaskStart",
      }),
      {
        abortSignal: options.abortSignal,
        onHookStart: (status) => {
          startedEvents.push(agentEvent.hookStatus(status.event, status.statusMessage));
        },
      }
    );

    return [...startedEvents, ...this.hookResultToEvents(result)];
  }

  async compactConversation(
    conversation: ConversationTurn[],
    options: {
      focus?: string;
      reason?: "manual" | "model-switch";
      session?: SessionHandle;
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<AgentRuntimeEvent[]> {
    const session = options.session ?? this.options.session;
    const profile = this.options.profile ?? PRIMARY_AGENT_PROFILE;
    const permissions = createToolPermissionView(profile, {
      deniedTools: this.options.parentPermissions?.deniedTools ?? [],
    });
    const instructions = await this.resolveBaseProjectInstructions();
    const system = this.buildSystemPromptWithProjectInstructions({ profile, permissions }, instructions);
    const tools = createProfileToolCatalog(permissions, []).definitions();
    const status = this.createContextStatus({
      system,
      prompt: buildConversationPrompt(
        conversation,
        conversation.at(-1)?.role === "user" ? conversation.at(-1)!.text : ""
      ),
      tools,
      session,
      modelCall: 0,
    });
    if (!status)
      return [agentEvent.systemMessage("Context is unavailable because no active model route is configured.")];
    if (
      conversation.length <= 4 ||
      (conversation.length <= 5 && conversation[0]?.text.startsWith("[Compacted context]\n"))
    ) {
      return [agentEvent.systemMessage("Context checkpoint is already compact; nothing needed to be summarized.")];
    }

    const reason = options.reason ?? "manual";
    const hook = await this.runStructuredPreCompactHook(status, reason, options.focus, session, options.abortSignal);
    if (hook.result.blocked || hook.result.stopped) {
      return [
        ...hook.events,
        ...(hook.result.messages.length === 0
          ? [agentEvent.systemMessage((hook.result.blocked ?? hook.result.stopped)!.message)]
          : []),
      ];
    }
    const compacted = await this.summarizeConversationProjection(conversation, {
      focus: [options.focus, ...hook.result.contexts].filter(Boolean).join("\n"),
      abortSignal: options.abortSignal,
    });
    const count = this.incrementSessionCompactions(session);
    const compactedTurns = projectionToConversationTurns(compacted.projection, []);
    const prompt = buildConversationPrompt(
      compactedTurns,
      compactedTurns.at(-1)?.role === "user" ? compactedTurns.at(-1)!.text : ""
    );
    const nextStatus = this.createContextStatus({
      system,
      prompt,
      tools,
      session,
      modelCall: 0,
      forceEstimate: true,
    })!;
    nextStatus.compactionsThisSession = count;
    nextStatus.compactionsThisTurn = 1;
    const snapshot: ContextCompactionSnapshot = {
      projectionVersion: 1,
      reason,
      ...(options.focus?.trim() ? { focus: options.focus.trim() } : {}),
      projection: compacted.projection,
      beforeTokens: status.budget.usedTokens,
      afterEstimatedTokens: nextStatus.budget.usedTokens,
      route: nextStatus.route,
      capacity: nextStatus.budget.capacity,
    };
    return [
      ...hook.events,
      agentEvent.contextCompaction(snapshot, nextStatus),
      agentEvent.systemMessage(
        `Context compacted: ~${snapshot.beforeTokens.toLocaleString()} → ~${snapshot.afterEstimatedTokens.toLocaleString()} tokens.`
      ),
    ];
  }

  /**
   * Streams one user chat turn through the agent loop. It builds the model
   * prompt with relevant KB context, calls the model, executes any requested
   * tools, feeds tool results back into the next prompt, and repeats until
   * the model returns a normal assistant message or the loop hits its safety
   * limit.
   *
   * This is the primary runtime execution contract. Compatibility wrappers
   * can collect the stream, but the runtime's own turn loop only knows about
   * ordered events.
   */
  async *submitMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    options: AgentRuntimeSubmitMessageOptions = {}
  ): AsyncIterable<AgentRuntimeEvent> {
    const session = options.session ?? this.options.session;
    const timing = session ? createSessionTurnTiming(this.context.logger, session) : undefined;
    this.activeTurnId = timing?.turnId;
    timing?.logger.debug({ event: "session_turn_started" }, "session turn started");

    try {
      for await (const event of this.runMessageStream(conversation, message, abortSignal, options, timing)) {
        yield event;
      }
    } finally {
      timing?.logger.debug(
        { event: "session_turn_finished", durationMs: Date.now() - timing.startedAt },
        "session turn finished"
      );
      this.activeTurnId = undefined;
    }
  }

  private async *runMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal: AbortSignal | undefined,
    options: AgentRuntimeSubmitMessageOptions,
    timing: SessionTurnTiming | undefined
  ): AsyncIterable<AgentRuntimeEvent> {
    const session = options.session ?? this.options.session;
    const turnLogger = timing?.logger ?? this.context.logger;
    for (const event of await this.runSessionStartHooks(session, { abortSignal })) {
      yield event;
    }

    const userPromptHookRun = this.startHookEvent(
      "UserPromptSubmit",
      this.createBaseHookPayload("UserPromptSubmit", session, {
        prompt: { text: message },
        prompt_text: message,
        user_prompt: message,
      }),
      { abortSignal }
    );
    for await (const event of userPromptHookRun.statusEvents) {
      yield event;
    }
    const userPromptHook = await userPromptHookRun.result;
    for (const event of this.hookResultToEvents(userPromptHook)) {
      yield event;
    }

    if (userPromptHook.blocked || userPromptHook.stopped) {
      const interruption = userPromptHook.blocked ?? userPromptHook.stopped!;

      if (userPromptHook.messages.length === 0) {
        yield agentEvent.systemMessage(interruption.message);
      }

      yield agentEvent.status("ready");
      return;
    }

    const promptSetupStartedAt = Date.now();
    const skillMentionActivations = await resolveSkillMentionActivations(
      message,
      createSkillsService({ workspaceRoot: this.context.workspaceRoot })
    );
    const modelMessage =
      skillMentionActivations.length > 0 ? formatSkillActivationPrompt(skillMentionActivations) : message;
    let activeConversation = [...conversation];
    if (activeConversation.at(-1)?.role !== "user" || activeConversation.at(-1)?.text !== modelMessage) {
      activeConversation.push({ role: "user", text: modelMessage });
    }
    let conversationPrompt = buildConversationPrompt(activeConversation, modelMessage);
    const promptSegments = await this.buildPromptSegmentsWithKnowledgeContext(conversationPrompt, message);
    const userPromptHookContext = formatHookContextsForPrompt("UserPromptSubmit", userPromptHook.contexts);
    if (userPromptHookContext) {
      promptSegments.push({ kind: "hook_context", text: userPromptHookContext, retention: "required" });
    }
    const prompt = renderPromptSegments(promptSegments);
    timing?.record("setup", "prompt_setup", promptSetupStartedAt);
    let nextPrompt = prompt;
    let totalDurationMs = 0;
    const tokenUsageTotals: TurnTokenUsageTotals = {};
    const profile = this.options.profile ?? PRIMARY_AGENT_PROFILE;
    const inheritedDeniedTools = this.options.parentPermissions?.deniedTools ?? [];
    const permissions = createToolPermissionView(profile, { deniedTools: inheritedDeniedTools });
    const mcpSetupStartedAt = Date.now();
    const mcpManager = await this.createMcpManager(profile, abortSignal);
    timing?.record("setup", "mcp_setup", mcpSetupStartedAt);
    const mcpDefinitions = this.createMcpDefinitions(mcpManager);
    const toolCatalog = createProfileToolCatalog(permissions, mcpDefinitions);
    const tools = toolCatalog.definitions();
    const subagents = new SubagentManager({
      context: this.context,
      parentSession: session,
      parentProfile: profile,
      parentPermissions: permissions,
      createRuntime: ({ profile: childProfile, parentPermissions, session: childSession }) =>
        new TopchesterAgentRuntime(this.context, {
          ...this.options,
          profile: childProfile,
          parentPermissions,
          session: childSession,
          liveL1Scheduler: this.liveL1Scheduler,
        }),
    });
    let lastModelId = "model";
    let afterTool: ToolCall["tool"] | undefined;
    let toolProtocolOverride = readToolProtocolEnvOverride();
    let requestedPlanClosure = false;
    let invalidToolCallRepairs = 0;
    const maxToolCallsPerTurn = readMaxToolCallsPerTurn();
    const planTodoMode = readPlanTodoMode();
    const maxPlanTodoUpdatesPerTurn = readMaxPlanTodoUpdatesPerTurn(planTodoMode);
    let planTodoUpdates = 0;
    const projectInstructionToolState = { shownSourceKeys: new Set<string>() };
    const persistedProjectInstructionKeys = new Set<string>();
    const readFileCache = createReadFileCache();
    let contextModelCall = 0;
    let compactionsThisTurn = 0;
    let ineffectiveCompactions = 0;
    let compactionLimitNoticeShown = false;
    let overflowRetryUsed = false;

    try {
      for (let toolCalls = 0; toolCalls <= maxToolCallsPerTurn; toolCalls += 1) {
        const startedAt = Date.now();
        const projectInstructionsStartedAt = Date.now();
        const projectInstructions = await this.resolveBaseProjectInstructions();
        timing?.record("setup", "project_instructions", projectInstructionsStartedAt);
        for (const event of createInstructionContextEventsFromProjectInstructions(
          projectInstructions,
          persistedProjectInstructionKeys
        )) {
          yield event;
        }
        const system = this.buildSystemPromptWithProjectInstructions({ profile, permissions }, projectInstructions);
        try {
          const discovered = await this.context.modelGateway.discoverModelCapacity?.("agent.primary");
          if (discovered) this.context.contextCapacityRegistry?.set(discovered.route, discovered.capacity);
        } catch (error) {
          turnLogger.debug(
            {
              event: "context_capacity_discovery_failed",
              error: error instanceof Error ? error.message : String(error),
            },
            "context capacity discovery failed"
          );
        }
        const modelRequestMetadata = this.resolveModelMetadata("agent.primary");
        contextModelCall += 1;
        let contextStatus = this.createContextStatus({
          system,
          prompt: nextPrompt,
          tools,
          session,
          modelCall: contextModelCall,
          providerOptions: { toolProtocolOverride },
        });
        const contextPolicy = contextPolicyFromConfig(this.context.config);
        if (
          contextStatus?.budget.compactAtTokens !== undefined &&
          contextStatus.budget.targetTokens !== undefined &&
          contextPolicy.enabled &&
          contextStatus.budget.usedTokens >= contextStatus.budget.compactAtTokens &&
          compactionsThisTurn < contextPolicy.maxCompactionsPerTurn &&
          ineffectiveCompactions < 2
        ) {
          const hook = await this.runStructuredPreCompactHook(
            contextStatus,
            "threshold",
            undefined,
            session,
            abortSignal
          );
          for (const event of hook.events) yield event;
          if (hook.result.stopped) {
            if (hook.result.messages.length === 0) yield agentEvent.systemMessage(hook.result.stopped.message);
            yield agentEvent.status("ready");
            return;
          }
          if (hook.result.blocked) {
            if (
              contextStatus.budget.hardPromptBudget !== undefined &&
              contextStatus.budget.usedTokens >= contextStatus.budget.hardPromptBudget
            ) {
              throw new Error(
                "PreCompact blocked compaction while the request is above its hard prompt budget. Run /compact or /new."
              );
            }
          } else {
            const beforeTokens = contextStatus.budget.usedTokens;
            const fixedRequestTokens = Math.max(0, beforeTokens - estimateTextTokens(nextPrompt));
            const pruning = prunePromptSegments(promptSegments, {
              targetTokens: Math.max(1, contextStatus.budget.targetTokens - fixedRequestTokens),
              keepRecentTokens: contextPolicy.keepRecentTokens,
            });
            let projection = conversationTurnsToProjection(activeConversation);
            let changed = false;
            if (pruning.afterTokens < pruning.beforeTokens) {
              changed = true;
              promptSegments.splice(0, promptSegments.length, ...pruning.segments);
              nextPrompt = renderPromptSegments(promptSegments);
              contextStatus = this.createContextStatus({
                system,
                prompt: nextPrompt,
                tools,
                session,
                modelCall: contextModelCall,
                providerOptions: { toolProtocolOverride },
                forceEstimate: true,
              });
              turnLogger.debug(
                {
                  event: "context_prompt_pruned",
                  beforeTokens: pruning.beforeTokens,
                  afterTokens: pruning.afterTokens,
                  savingsPercent: pruning.savingsPercent,
                  prunedAssociations: pruning.prunedAssociations,
                },
                "replaceable prompt segments pruned"
              );
            }
            if (
              contextStatus &&
              contextStatus.budget.usedTokens >= (contextStatus.budget.compactAtTokens ?? Number.POSITIVE_INFINITY) &&
              activeConversation.length > 4
            ) {
              const compacted = await this.summarizeConversationProjection(activeConversation, {
                focus: formatCompactionGuidance(promptSegments, hook.result.contexts),
                abortSignal,
              });
              const compactedTurns = projectionToConversationTurns(compacted.projection, []);
              const nextConversationPrompt = buildConversationPrompt(compactedTurns, modelMessage);
              replaceConversationInPromptSegments(promptSegments, conversationPrompt, nextConversationPrompt);
              nextPrompt = renderPromptSegments(promptSegments);
              conversationPrompt = nextConversationPrompt;
              activeConversation = compactedTurns;
              projection = compacted.projection;
              changed = true;
              contextStatus = this.createContextStatus({
                system,
                prompt: nextPrompt,
                tools,
                session,
                modelCall: contextModelCall,
                providerOptions: { toolProtocolOverride },
                forceEstimate: true,
              });
            }
            if (changed && contextStatus) {
              compactionsThisTurn += 1;
              if (!isEffectiveCompaction(beforeTokens, contextStatus.budget.usedTokens)) ineffectiveCompactions += 1;
              const count = this.incrementSessionCompactions(session);
              contextStatus = this.createContextStatus({
                system,
                prompt: nextPrompt,
                tools,
                session,
                modelCall: contextModelCall,
                providerOptions: { toolProtocolOverride },
                forceEstimate: true,
              });
              if (contextStatus) {
                contextStatus.compactionsThisSession = count;
                contextStatus.compactionsThisTurn = compactionsThisTurn;
                yield agentEvent.contextCompaction(
                  {
                    projectionVersion: 1,
                    reason: "threshold",
                    projection: projectionWithRuntimeSegments(projection, promptSegments),
                    beforeTokens,
                    afterEstimatedTokens: contextStatus.budget.usedTokens,
                    route: contextStatus.route,
                    capacity: contextStatus.budget.capacity,
                  },
                  contextStatus
                );
                if (
                  contextStatus.budget.hardPromptBudget !== undefined &&
                  contextStatus.budget.usedTokens >= contextStatus.budget.hardPromptBudget
                ) {
                  throw new Error(
                    "Compaction could not reduce the request below its hard prompt budget. Run /compact <focus> or /new."
                  );
                }
              }
            }
          }
        }
        if (
          contextStatus?.budget.compactAtTokens !== undefined &&
          contextStatus.budget.usedTokens >= contextStatus.budget.compactAtTokens &&
          (ineffectiveCompactions >= 2 || compactionsThisTurn >= contextPolicy.maxCompactionsPerTurn) &&
          !compactionLimitNoticeShown
        ) {
          compactionLimitNoticeShown = true;
          yield agentEvent.systemMessage(
            "Automatic compaction stopped after reaching its bounded attempt limit. Run /compact <focus> or /new if more space is needed."
          );
        }
        if (
          contextStatus?.budget.hardPromptBudget !== undefined &&
          contextStatus.budget.usedTokens >= contextStatus.budget.hardPromptBudget
        ) {
          throw new Error(
            "The request is above its hard prompt budget and cannot be sent safely. Run /compact <focus> or /new."
          );
        }
        if (contextStatus) yield agentEvent.contextUsage(contextStatus);
        turnLogger.debug(
          {
            event: "model_prompt",
            purpose: "agent.primary",
            providerId: modelRequestMetadata?.providerId,
            modelId: modelRequestMetadata?.modelId,
            reasoningEffort: modelRequestMetadata?.providerConfig.reasoningEffort,
            afterTool,
            toolProtocol: toolProtocolOverride,
            promptLength: nextPrompt.length,
            systemLength: system.length,
            projectInstructionSources: summarizeProjectInstructionSources(projectInstructions),
            projectInstructionsTruncated: projectInstructions.truncated,
            prompt: nextPrompt,
            system,
          },
          afterTool ? "model prompt after tool" : "model prompt"
        );
        const modelStartedAt = Date.now();
        const callModel = () =>
          generateAgentStep(this.context, {
            purpose: "agent.primary",
            system,
            prompt: nextPrompt,
            sessionId: session?.metadata.rootSessionId ?? session?.sessionId,
            abortSignal,
            toolProtocol: toolProtocolOverride,
            onReasoning: options.onReasoning,
            tools,
            toolCatalog,
          });
        let result: ModelAgentResult;
        try {
          result = await callModel();
        } catch (error) {
          const overflow = classifyContextOverflow(error);
          if (!overflow.overflow || overflowRetryUsed) throw error;
          if (compactionsThisTurn >= contextPolicy.maxCompactionsPerTurn) {
            throw new Error(
              "The provider rejected the request for context overflow after the turn reached its compaction attempt limit. Run /compact <focus> or /new."
            );
          }
          overflowRetryUsed = true;
          if (contextStatus && overflow.maximumTokens && contextPolicy.learnProviderLimits) {
            const learned: ContextCapacity = {
              maxInputTokens: overflow.maximumTokens,
              source: overflow.source === "reported" ? "error-reported" : "error-inferred",
              confidence: overflow.source === "reported" ? "reported" : "inferred",
              observedAt: new Date().toISOString(),
            };
            this.learnedCapacityByRoute.set(contextRouteKey(contextStatus.route), learned);
            this.context.contextCapacityRegistry?.set(contextStatus.route, learned);
          }
          let refreshed =
            this.createContextStatus({
              system,
              prompt: nextPrompt,
              tools,
              session,
              modelCall: contextModelCall,
              providerOptions: { toolProtocolOverride },
              forceEstimate: true,
            }) ?? contextStatus;
          if (!refreshed) throw error;
          const hook = await this.runStructuredPreCompactHook(refreshed, "overflow", undefined, session, abortSignal);
          for (const event of hook.events) yield event;
          if (hook.result.blocked || hook.result.stopped) {
            throw new Error(
              `${(hook.result.blocked ?? hook.result.stopped)!.message} The provider rejected the request for context overflow.`
            );
          }
          const beforeRetryTokens = refreshed.budget.usedTokens;
          const pruning = prunePromptSegments(promptSegments, {
            targetTokens:
              refreshed.budget.targetTokens ?? Math.max(1_024, Math.floor(estimateTextTokens(nextPrompt) * 0.6)),
            keepRecentTokens: contextPolicy.keepRecentTokens,
          });
          if (pruning.afterTokens < pruning.beforeTokens) {
            promptSegments.splice(0, promptSegments.length, ...pruning.segments);
            nextPrompt = renderPromptSegments(promptSegments);
            refreshed =
              this.createContextStatus({
                system,
                prompt: nextPrompt,
                tools,
                session,
                modelCall: contextModelCall,
                providerOptions: { toolProtocolOverride },
                forceEstimate: true,
              }) ?? refreshed;
          }
          const compacted =
            activeConversation.length > 4
              ? await this.summarizeConversationProjection(activeConversation, {
                  focus: formatCompactionGuidance(promptSegments, hook.result.contexts),
                  abortSignal,
                })
              : compactConversationDeterministically(activeConversation, {
                  keepRecentTokens: contextPolicy.keepRecentTokens,
                });
          const compactedTurns = projectionToConversationTurns(compacted.projection, []);
          const nextConversationPrompt = buildConversationPrompt(compactedTurns, modelMessage);
          replaceConversationInPromptSegments(promptSegments, conversationPrompt, nextConversationPrompt);
          nextPrompt = renderPromptSegments(promptSegments);
          conversationPrompt = nextConversationPrompt;
          activeConversation = compactedTurns;
          compactionsThisTurn += 1;
          const count = this.incrementSessionCompactions(session);
          const retryStatus = this.createContextStatus({
            system,
            prompt: nextPrompt,
            tools,
            session,
            modelCall: contextModelCall,
            providerOptions: { toolProtocolOverride },
            forceEstimate: true,
          })!;
          retryStatus.compactionsThisSession = count;
          retryStatus.compactionsThisTurn = compactionsThisTurn;
          const prunedAnyPromptContent = pruning.afterTokens < pruning.beforeTokens;
          if (!prunedAnyPromptContent && !isEffectiveCompaction(beforeRetryTokens, retryStatus.budget.usedTokens)) {
            throw new Error(
              "Context overflow recovery could not reduce the prompt enough. Run /compact <focus> or /new."
            );
          }
          if (
            retryStatus.budget.hardPromptBudget !== undefined &&
            retryStatus.budget.usedTokens >= retryStatus.budget.hardPromptBudget
          ) {
            throw new Error(
              "Context overflow recovery remains above the hard prompt budget. Run /compact <focus> or /new."
            );
          }
          yield agentEvent.contextCompaction(
            {
              projectionVersion: 1,
              reason: "overflow",
              projection: projectionWithRuntimeSegments(compacted.projection, promptSegments),
              beforeTokens: beforeRetryTokens,
              afterEstimatedTokens: retryStatus.budget.usedTokens,
              route: retryStatus.route,
              capacity: retryStatus.budget.capacity,
            },
            retryStatus
          );
          result = await callModel();
        }
        const modelDurationMs = Date.now() - modelStartedAt;
        const durationMs = Date.now() - startedAt;
        const modelToolCalls = getExecutableModelToolCalls(result, toolCatalog);
        const toolCall = modelToolCalls[0];
        totalDurationMs += durationMs;
        lastModelId = result.modelId;
        addTokenUsageTotals(tokenUsageTotals, result.usage);
        const providerStatus = this.createContextStatus({
          system,
          prompt: nextPrompt,
          tools,
          session,
          modelCall: contextModelCall,
          providerOptions: { toolProtocolOverride },
          providerPromptTokens: result.usage?.inputTokens,
        });
        if (providerStatus) {
          providerStatus.compactionsThisTurn = compactionsThisTurn;
          yield agentEvent.contextUsage(providerStatus);
        }

        turnLogger.debug(
          {
            event: "model_response",
            purpose: "agent.primary",
            modelId: result.modelId,
            providerId: result.providerId,
            reasoningEffort: result.reasoningEffort,
            durationMs,
            modelDurationMs,
            totalDurationMs,
            textLength: result.text.length,
            usage: result.usage,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            totalTokens: result.usage?.totalTokens,
            cacheReadTokens: result.usage?.cacheReadTokens,
            cacheWriteTokens: result.usage?.cacheWriteTokens,
            costUsd: result.usage?.costUsd,
            hasToolCall: Boolean(toolCall),
            toolProtocol: result.toolProtocol,
            protocolAttempts: result.protocolAttempts,
            toolCallSource: toolCall?.source,
            fallbackReason: result.fallbackReason,
            providerRejectedTools: result.providerRejectedTools,
            openRouterRoutingApplied: result.openRouterRoutingApplied,
            afterTool,
          },
          afterTool ? "model response after tool" : "model response"
        );
        turnLogger.trace(
          {
            event: "model_response_text",
            purpose: "agent.primary",
            modelId: result.modelId,
            providerId: result.providerId,
            reasoningEffort: result.reasoningEffort,
            afterTool,
            toolProtocol: result.toolProtocol,
            text: result.text,
          },
          afterTool ? "model response text after tool" : "model response text"
        );

        if (result.providerRejectedTools && result.toolProtocol === "text-json") {
          toolProtocolOverride = "text-json";
        } else if (result.providerRejectedTools && result.toolProtocol === "text-xml") {
          toolProtocolOverride = "text-xml";
        }

        if (!toolCall) {
          const rejectedToolCall = parseToolCallRejection(
            result.text,
            getTextToolCallSources(result.toolProtocol),
            toolCatalog
          );

          if (rejectedToolCall && invalidToolCallRepairs < 2) {
            invalidToolCallRepairs += 1;
            turnLogger.debug(
              {
                event: "invalid_text_tool_call",
                purpose: "agent.primary",
                tool: rejectedToolCall.tool,
                reason: rejectedToolCall.reason,
                source: rejectedToolCall.source,
                afterTool,
              },
              "invalid text tool call"
            );
            promptSegments.push({
              kind: "repair",
              text: formatInvalidToolCallRepairInstruction(rejectedToolCall),
              retention: "required",
            });
            nextPrompt = renderPromptSegments(promptSegments);
            continue;
          }

          const plan = this.taskPlan.get();
          const finalText = stripSuppressiblePlanTodoPrefix(result.text, plan) ?? result.text;

          if (planTodoMode === "normal" && hasOpenTaskPlan(plan)) {
            if (!requestedPlanClosure) {
              requestedPlanClosure = true;
              promptSegments.push({
                kind: "repair",
                text: formatOpenPlanClosureInstruction(finalText, result.toolProtocol),
                retention: "required",
              });
              nextPrompt = renderPromptSegments(promptSegments);
              continue;
            }

            yield agentEvent.taskPlan(this.taskPlan.update({ items: [] }));
          }

          const finalMessage = finalText.trim() || "I got an empty response from the model.";

          yield agentEvent.assistantMessage(
            finalMessage,
            formatAgentMessageMeta(result.modelId, totalDurationMs, tokenUsageTotals)
          );
          for await (const event of this.streamStopHookEvents(session, finalMessage, "completed", abortSignal)) {
            yield event;
          }
          yield agentEvent.status("ready");
          return;
        }

        if (toolCalls === maxToolCallsPerTurn) {
          yield agentEvent.choice({
            tone: "warning",
            title: "Tool call limit reached",
            body: `Stopped after ${maxToolCallsPerTurn} tool calls in one turn. Continue starts another turn; abort leaves the call stopped.`,
            actions: [
              choiceAction("Continue", "Continue the previous task from where you stopped."),
              choiceAction("Abort", ABORT_CHOICE_VALUE),
            ],
          });
          yield agentEvent.status("ready");
          return;
        }

        if (modelToolCalls.length > 1 && modelToolCalls.every((call) => call.tool === "task")) {
          const taskCalls = modelToolCalls.map((call) => call as ToolCall);
          const taskResults: Array<ToolExecutionResult<ToolResult> | undefined> = [];
          const postHookContexts: string[] = [];

          for (let index = 0; index < taskCalls.length; index += DEFAULT_TASK_CONCURRENCY) {
            const batch = taskCalls.slice(index, index + DEFAULT_TASK_CONCURRENCY);
            const executableBatch: Array<{ call: ToolCall; resultIndex: number; toolCallId?: string }> = [];

            for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
              const call = batch[batchIndex]!;
              const resultIndex = index + batchIndex;
              const preHookRun = this.startPreToolUseHook(call, modelToolCalls[resultIndex]?.id, session, abortSignal);
              for await (const event of preHookRun.statusEvents) {
                yield event;
              }
              const preHook = await preHookRun.result;
              for (const event of this.hookResultToEvents(preHook)) {
                yield event;
              }

              if (preHook.stopped) {
                if (preHook.messages.length === 0) {
                  yield agentEvent.systemMessage(preHook.stopped.message);
                }

                yield agentEvent.status("ready");
                return;
              }

              if (preHook.blocked) {
                taskResults[resultIndex] = createToolErrorResult(call.tool, preHook.blocked.message);
                continue;
              }

              executableBatch.push({ call, resultIndex, toolCallId: modelToolCalls[resultIndex]?.id });
            }

            if (executableBatch.length === 0) {
              continue;
            }

            const taskEventQueue = createRuntimeEventQueue();
            const batchResultPromise = Promise.all(
              executableBatch.map((entry) =>
                executeToolCall(this.context.workspaceRoot, entry.call, {
                  logger: timing?.logger ?? this.context.logger,
                  config: this.context.config,
                  taskPlan: this.taskPlan,
                  profile,
                  permissions,
                  subagents,
                  projectInstructions: projectInstructionToolState,
                  currentUserMessage: message,
                  readFileCache,
                  abortSignal,
                  toolCallId: entry.toolCallId,
                  sessionId: session?.sessionId,
                  rootSessionId: session?.metadata.rootSessionId,
                  turnId: timing?.turnId,
                  toolCatalog,
                  onFileTouch: (event) => this.liveL1Scheduler.enqueue(event),
                  eventSink: (event) => taskEventQueue.push(event),
                })
              )
            ).finally(() => {
              taskEventQueue.close();
            });

            for await (const event of taskEventQueue) {
              yield event;
            }

            const batchResults = await batchResultPromise;

            for (let batchIndex = 0; batchIndex < executableBatch.length; batchIndex += 1) {
              const entry = executableBatch[batchIndex]!;
              taskResults[entry.resultIndex] = batchResults[batchIndex]!;
            }
          }

          for (let index = 0; index < taskCalls.length; index += 1) {
            const call = taskCalls[index]!;
            const toolResult = taskResults[index]!;

            for (const event of createInstructionContextEventsFromToolResult(
              toolResult,
              persistedProjectInstructionKeys
            )) {
              yield event;
            }
            yield agentEvent.toolCall(
              call,
              formatToolCallMessage(call, toolResult),
              getToolCallDisplayDiff(toolResult)
            );
            const postHookRun = this.startPostToolUseHook(
              call,
              modelToolCalls[index]?.id,
              toolResult,
              session,
              abortSignal
            );
            for await (const event of postHookRun.statusEvents) {
              yield event;
            }
            const postHook = await postHookRun.result;
            for (const event of this.hookResultToEvents(postHook)) {
              yield event;
            }

            postHookContexts.push(...postHook.contexts);

            if (postHook.stopped) {
              if (postHook.messages.length === 0) {
                yield agentEvent.systemMessage(postHook.stopped.message);
              }

              yield agentEvent.status("ready");
              return;
            }
          }

          afterTool = "task";
          appendToolContinuationSegments(promptSegments, {
            calls: taskCalls,
            results: taskResults as ToolExecutionResult<ToolResult>[],
            modelCall: contextModelCall,
            continuation: formatContinuationInstruction(
              result.toolProtocol,
              taskResults.at(-1)!,
              isToolAllowed(permissions, "plan_todo"),
              planTodoMode
            ),
            hookContexts: postHookContexts,
            steering: options.steering,
          });
          nextPrompt = renderPromptSegments(promptSegments);
          continue;
        }

        if (modelToolCalls.length > 1 && modelToolCalls.every((call) => toolCatalog.isParallelSafe(call.tool))) {
          const parallelCalls = modelToolCalls.map((call) => call as ToolCall);
          const parallelResults: Array<ToolExecutionResult<ToolResult> | undefined> = [];
          const executableCalls: Array<{ call: ToolCall; resultIndex: number; toolCallId?: string }> = [];
          const postHookContexts: string[] = [];

          for (let index = 0; index < parallelCalls.length; index += 1) {
            const call = parallelCalls[index]!;
            const preHookRun = this.startPreToolUseHook(call, modelToolCalls[index]?.id, session, abortSignal);
            for await (const event of preHookRun.statusEvents) {
              yield event;
            }
            const preHook = await preHookRun.result;
            for (const event of this.hookResultToEvents(preHook)) {
              yield event;
            }

            if (preHook.stopped) {
              if (preHook.messages.length === 0) {
                yield agentEvent.systemMessage(preHook.stopped.message);
              }

              yield agentEvent.status("ready");
              return;
            }

            if (preHook.blocked) {
              parallelResults[index] = createToolErrorResult(call.tool, preHook.blocked.message);
              continue;
            }

            executableCalls.push({ call, resultIndex: index, toolCallId: modelToolCalls[index]?.id });
          }

          const executedResults = await Promise.all(
            executableCalls.map((entry) =>
              executeToolCall(this.context.workspaceRoot, entry.call, {
                logger: timing?.logger ?? this.context.logger,
                config: this.context.config,
                taskPlan: this.taskPlan,
                profile,
                permissions,
                subagents,
                projectInstructions: projectInstructionToolState,
                currentUserMessage: message,
                readFileCache,
                abortSignal,
                toolCallId: entry.toolCallId,
                sessionId: session?.sessionId,
                rootSessionId: session?.metadata.rootSessionId,
                turnId: timing?.turnId,
                toolCatalog,
                onFileTouch: (event) => this.liveL1Scheduler.enqueue(event),
              })
            )
          );

          for (let index = 0; index < executableCalls.length; index += 1) {
            const entry = executableCalls[index]!;
            parallelResults[entry.resultIndex] = executedResults[index]!;
          }

          for (let index = 0; index < parallelCalls.length; index += 1) {
            const call = parallelCalls[index]!;
            const toolResult = parallelResults[index]!;

            for (const event of createInstructionContextEventsFromToolResult(
              toolResult,
              persistedProjectInstructionKeys
            )) {
              yield event;
            }
            yield agentEvent.toolCall(
              call,
              formatToolCallMessage(call, toolResult),
              getToolCallDisplayDiff(toolResult)
            );
            const postHookRun = this.startPostToolUseHook(
              call,
              modelToolCalls[index]?.id,
              toolResult,
              session,
              abortSignal
            );
            for await (const event of postHookRun.statusEvents) {
              yield event;
            }
            const postHook = await postHookRun.result;
            for (const event of this.hookResultToEvents(postHook)) {
              yield event;
            }

            postHookContexts.push(...postHook.contexts);

            if (postHook.stopped) {
              if (postHook.messages.length === 0) {
                yield agentEvent.systemMessage(postHook.stopped.message);
              }

              yield agentEvent.status("ready");
              return;
            }
          }

          afterTool = parallelCalls.at(-1)?.tool;
          appendToolContinuationSegments(promptSegments, {
            calls: parallelCalls,
            results: parallelResults as ToolExecutionResult<ToolResult>[],
            modelCall: contextModelCall,
            continuation: formatContinuationInstruction(
              result.toolProtocol,
              parallelResults.at(-1)!,
              isToolAllowed(permissions, "plan_todo"),
              planTodoMode
            ),
            hookContexts: postHookContexts,
            steering: options.steering,
          });
          nextPrompt = renderPromptSegments(promptSegments);
          continue;
        }

        const executableToolCall = toolCall as ToolCall;
        const suppressiblePlanTodoAnswer = getSuppressiblePlanTodoAnswer(
          executableToolCall,
          result.text,
          this.taskPlan.get()
        );

        if (suppressiblePlanTodoAnswer !== undefined) {
          const finalMessage = suppressiblePlanTodoAnswer || "I got an empty response from the model.";

          yield agentEvent.assistantMessage(
            finalMessage,
            formatAgentMessageMeta(result.modelId, totalDurationMs, tokenUsageTotals)
          );
          for await (const event of this.streamStopHookEvents(session, finalMessage, "completed", abortSignal)) {
            yield event;
          }
          yield agentEvent.status("ready");
          return;
        }

        let toolResult: ToolExecutionResult<ToolResult>;
        const planTodoRejection = validatePlanTodoCall(executableToolCall, this.taskPlan.get(), {
          afterTool,
          planTodoUpdates,
          maxPlanTodoUpdatesPerTurn,
        });

        if (planTodoRejection) {
          toolResult = createToolErrorResult(executableToolCall.tool, planTodoRejection);
        } else {
          const preHookRun = this.startPreToolUseHook(executableToolCall, toolCall.id, session, abortSignal);
          for await (const event of preHookRun.statusEvents) {
            yield event;
          }
          const preHook = await preHookRun.result;
          for (const event of this.hookResultToEvents(preHook)) {
            yield event;
          }

          if (preHook.stopped) {
            if (preHook.messages.length === 0) {
              yield agentEvent.systemMessage(preHook.stopped.message);
            }

            yield agentEvent.status("ready");
            return;
          }

          if (preHook.blocked) {
            toolResult = createToolErrorResult(executableToolCall.tool, preHook.blocked.message);
          } else {
            const approvalStartedAt = Date.now();
            const approval = await this.resolveBashApproval(
              executableToolCall,
              toolCall.id,
              options,
              session,
              abortSignal
            );
            if (executableToolCall.tool === "bash") {
              timing?.record("approval", "tool_approval", approvalStartedAt);
            }
            for (const event of approval.events) {
              yield event;
            }

            if (approval.cancelled && approval.stopped) {
              if (!approval.events.some((event) => event.type === "message" && event.text === approval.reason)) {
                yield agentEvent.systemMessage(approval.reason);
              }

              yield agentEvent.status("ready");
              return;
            }

            if (approval.cancelled) {
              toolResult = createToolErrorResult(executableToolCall.tool, approval.reason);
            } else {
              const toolEventQueue = createRuntimeEventQueue();
              const toolResultPromise = executeToolCall(this.context.workspaceRoot, executableToolCall, {
                logger: timing?.logger ?? this.context.logger,
                config: this.context.config,
                bashApprovals: { allowExactCommands: approval.approvedCommands },
                taskPlan: this.taskPlan,
                profile,
                permissions,
                subagents,
                projectInstructions: projectInstructionToolState,
                currentUserMessage: message,
                readFileCache,
                abortSignal,
                toolCallId: toolCall.id,
                sessionId: session?.sessionId,
                rootSessionId: session?.metadata.rootSessionId,
                turnId: timing?.turnId,
                toolCatalog,
                onFileTouch: (event) => this.liveL1Scheduler.enqueue(event),
                eventSink: (event) => toolEventQueue.push(event),
              }).finally(() => {
                toolEventQueue.close();
              });

              for await (const event of toolEventQueue) {
                yield event;
              }

              toolResult = await toolResultPromise;
            }
          }
        }

        for (const event of createInstructionContextEventsFromToolResult(toolResult, persistedProjectInstructionKeys)) {
          yield event;
        }

        yield agentEvent.toolCall(
          executableToolCall,
          formatToolCallMessage(executableToolCall, toolResult),
          getToolCallDisplayDiff(toolResult)
        );
        if (!isToolErrorResult(toolResult) && toolResult.tool === "plan_todo") {
          planTodoUpdates += 1;
          yield agentEvent.taskPlan(toolResult.plan);
        }

        const postHookRun = this.startPostToolUseHook(
          executableToolCall,
          toolCall.id,
          toolResult,
          session,
          abortSignal
        );
        for await (const event of postHookRun.statusEvents) {
          yield event;
        }
        const postHook = await postHookRun.result;
        for (const event of this.hookResultToEvents(postHook)) {
          yield event;
        }

        if (postHook.stopped) {
          if (postHook.messages.length === 0) {
            yield agentEvent.systemMessage(postHook.stopped.message);
          }

          yield agentEvent.status("ready");
          return;
        }

        afterTool = executableToolCall.tool;
        appendToolContinuationSegments(promptSegments, {
          calls: [executableToolCall],
          results: [toolResult],
          modelCall: contextModelCall,
          continuation: formatContinuationInstruction(
            result.toolProtocol,
            toolResult,
            isToolAllowed(permissions, "plan_todo"),
            planTodoMode
          ),
          hookContexts: postHook.contexts,
          steering: options.steering,
        });
        nextPrompt = renderPromptSegments(promptSegments);
      }

      const finalMessage = "I stopped because the tool loop ended unexpectedly.";

      yield agentEvent.assistantMessage(
        finalMessage,
        formatAgentMessageMeta(lastModelId, totalDurationMs, tokenUsageTotals)
      );
      for await (const event of this.streamStopHookEvents(session, finalMessage, "failed", abortSignal)) {
        yield event;
      }
      yield agentEvent.status("ready");
    } finally {
      await mcpManager?.close();
    }
  }

  /**
   * Compatibility wrapper for callers that still expect a completed event
   * array or use the older `onEvent` callback shape.
   */
  async submitMessage(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    onEvent?: AgentRuntimeEventSink,
    options: AgentRuntimeSubmitMessageOptions = {}
  ): Promise<AgentRuntimeEvent[]> {
    const events: AgentRuntimeEvent[] = [];

    for await (const event of this.submitMessageStream(conversation, message, abortSignal, options)) {
      events.push(event);
      await onEvent?.(event);
    }

    return events;
  }

  private async createMcpManager(
    profile: AgentProfile,
    abortSignal: AbortSignal | undefined
  ): Promise<McpManager | undefined> {
    if (profile.id !== PRIMARY_AGENT_PROFILE.id || !this.context.config.mcp) {
      return undefined;
    }

    const manager = new McpManager({
      workspaceRoot: this.context.workspaceRoot,
      config: this.context.config.mcp,
      logger: this.context.logger,
      signal: abortSignal,
    });

    await manager.connectAll();

    for (const status of manager.statuses()) {
      this.context.logger.debug({ event: "mcp_server_status", ...status }, "MCP server status");
    }

    return manager;
  }

  private createMcpDefinitions(manager: McpManager | undefined): RuntimeToolDefinition[] {
    if (!manager) {
      return [];
    }

    const converted = createMcpToolDefinitions(manager.connectedServers());

    for (const error of converted.errors) {
      this.context.logger.warn({ event: "mcp_tool_conversion_failed", error }, "MCP tool conversion failed");
    }

    this.context.logger.debug(
      { event: "mcp_tools_exposed", toolCount: converted.definitions.length },
      "MCP tools exposed"
    );

    return converted.definitions;
  }

  private startPreToolUseHook(
    call: ToolCall,
    toolCallId: string | undefined,
    session: SessionHandle | undefined,
    abortSignal: AbortSignal | undefined
  ): { statusEvents: AsyncIterable<AgentRuntimeEvent>; result: Promise<HookRunResult> } {
    return this.startHookEvent("PreToolUse", this.createToolHookPayload("PreToolUse", call, toolCallId, session), {
      toolName: call.tool,
      abortSignal,
    });
  }

  private startPostToolUseHook(
    call: ToolCall,
    toolCallId: string | undefined,
    result: ToolExecutionResult<ToolResult>,
    session: SessionHandle | undefined,
    abortSignal: AbortSignal | undefined
  ): { statusEvents: AsyncIterable<AgentRuntimeEvent>; result: Promise<HookRunResult> } {
    return this.startHookEvent(
      "PostToolUse",
      this.createToolHookPayload("PostToolUse", call, toolCallId, session, { result }),
      { toolName: call.tool, abortSignal }
    );
  }

  private async *streamStopHookEvents(
    session: SessionHandle | undefined,
    finalMessage: string,
    status: "completed" | "failed",
    abortSignal: AbortSignal | undefined
  ): AsyncIterable<AgentRuntimeEvent> {
    const hookRun = this.startHookEvent(
      "Stop",
      this.createBaseHookPayload("Stop", session, {
        taskCompleteAlias: "TaskComplete",
        finalMessage,
        status,
      }),
      { abortSignal }
    );

    for await (const event of hookRun.statusEvents) {
      yield event;
    }

    const result = await hookRun.result;

    for (const event of this.hookResultToEvents(result)) {
      yield event;
    }
  }

  private async runHookEvent(
    event: HookRunPayload["event"],
    payload: HookRunPayload,
    options: RunTopchesterHooksOptions = {}
  ): Promise<HookRunResult> {
    const logFields = {
      sessionId: payload.sessionId,
      rootSessionId: payload.rootSessionId,
      turnId: payload.turnId,
    };
    const hookContext =
      payload.sessionId && typeof this.context.logger.child === "function"
        ? { ...this.context, logger: this.context.logger.child(logFields) }
        : this.context;

    return runTopchesterHooks(hookContext, event, payload, options);
  }

  private startHookEvent(
    event: HookRunPayload["event"],
    payload: HookRunPayload,
    options: Omit<RunTopchesterHooksOptions, "onHookStart"> = {}
  ): { statusEvents: AsyncIterable<AgentRuntimeEvent>; result: Promise<HookRunResult> } {
    const queue = createRuntimeEventQueue();
    const result = this.runHookEvent(event, payload, {
      ...options,
      onHookStart: (status) => queue.push(agentEvent.hookStatus(status.event, status.statusMessage)),
    }).finally(() => {
      queue.close();
    });

    return { statusEvents: queue, result };
  }

  private createBaseHookPayload(
    event: HookRunPayload["event"],
    session: SessionHandle | undefined,
    extra: Record<string, unknown> = {}
  ): HookRunPayload {
    return {
      hook_event_name: event,
      event,
      cwd: this.context.workspaceRoot,
      workspaceRoot: this.context.workspaceRoot,
      source: "topchester",
      ...this.createHookModelPayload("agent.primary"),
      ...(session
        ? {
            session_id: session.sessionId,
            sessionId: session.sessionId,
            root_session_id: session.metadata.rootSessionId,
            rootSessionId: session.metadata.rootSessionId,
            ...(this.activeTurnId
              ? {
                  turn_id: this.activeTurnId,
                  turnId: this.activeTurnId,
                }
              : {}),
            session: {
              sessionId: session.sessionId,
              rootSessionId: session.metadata.rootSessionId,
              parentSessionId: session.metadata.parentSessionId,
              source: session.metadata.source,
            },
          }
        : {}),
      ...extra,
    };
  }

  private createHookModelPayload(purpose: ModelPurpose): Partial<HookModelPayload> {
    const resolved = this.resolveModelMetadata(purpose);

    if (!resolved) {
      return {};
    }

    const modelRef = `${resolved.providerId}/${resolved.modelId}`;

    return {
      model_purpose: resolved.purpose,
      model_provider: resolved.providerId,
      model_id: resolved.modelId,
      model_ref: modelRef,
      model: {
        purpose: resolved.purpose,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        ref: modelRef,
      },
    };
  }

  private createContextStatus(options: {
    system: string;
    prompt: string;
    tools: readonly RuntimeToolDefinition[];
    session?: SessionHandle;
    modelCall: number;
    providerPromptTokens?: number;
    forceEstimate?: boolean;
    providerOptions?: unknown;
  }): ContextStatus | undefined {
    const resolved = this.resolveModelMetadata("agent.primary");
    if (!resolved) return undefined;
    const route = {
      providerId: resolved.providerId,
      baseURL: resolved.providerConfig.baseURL,
      modelId: resolved.modelId,
    };
    const key = contextRouteKey(route);
    const policy = contextPolicyFromConfig(this.context.config);
    const configured = configuredCapacityForRoute(this.context.config, route);
    const stored = this.context.contextCapacityRegistry?.get(route) ?? this.learnedCapacityByRoute.get(key);
    const capacity = resolveContextCapacity({
      ...(configured.source === "unknown"
        ? {}
        : configured.source === "config"
          ? { config: configured }
          : { assumed: configured }),
      ...(stored?.source === "provider" ? { provider: stored } : {}),
      ...(stored?.source === "catalog" ? { catalog: stored } : {}),
      ...(stored?.source === "error-reported" || stored?.source === "error-inferred" ? { learned: stored } : {}),
    });
    const request: RequestEstimateInput = {
      route,
      system: options.system,
      prompt: options.prompt,
      toolDefinitions: options.tools,
      providerOptions: {
        reasoningEffort: resolved.providerConfig.reasoningEffort ?? null,
        serviceTier: resolved.providerConfig.service_tier ?? null,
        toolProtocol: resolved.modelConfig.toolProtocol ?? resolved.providerConfig.toolProtocol ?? null,
        promptCaching: resolved.providerConfig.promptCaching ?? null,
        structuredOutputs: resolved.providerConfig.supportsStructuredOutputs ?? null,
        openRouterToolRouting: resolved.providerConfig.openRouterToolRouting ?? null,
        request: options.providerOptions ?? null,
      },
    };
    const sessionKey = options.session?.sessionId ?? `workspace:${this.context.workspaceRoot}`;
    const previous = options.forceEstimate ? undefined : this.contextUsageBySession.get(sessionKey);
    const previousRequest = options.forceEstimate ? undefined : this.contextRequestBySession.get(sessionKey);
    const appendedToProviderSnapshot =
      previous?.source === "provider" &&
      previousRequest !== undefined &&
      request.prompt.startsWith(previousRequest.prompt) &&
      fingerprintProviderRequest({ ...request, prompt: previousRequest.prompt }) === previous.requestBaseFingerprint;
    const accountingRequest = appendedToProviderSnapshot ? previousRequest : request;
    const usage = reconcilePromptUsage({
      request: accountingRequest,
      prior: previous,
      ...(options.providerPromptTokens === undefined ? {} : { providerPromptTokens: options.providerPromptTokens }),
      ...(appendedToProviderSnapshot ? { trailingText: request.prompt.slice(previousRequest.prompt.length) } : {}),
      modelCall: options.modelCall,
    });
    this.contextUsageBySession.set(sessionKey, usage);
    if (options.providerPromptTokens !== undefined) this.contextRequestBySession.set(sessionKey, request);
    const usedTokens = usage.promptTokens + usage.trailingEstimatedTokens;
    const budget = deriveContextBudget(capacity, usedTokens, policy, {
      providerSnapshot: usage.source === "provider",
    });
    const status: ContextStatus = {
      route,
      usage,
      budget,
      compactionsThisSession: this.contextCompactionsBySession.get(sessionKey) ?? 0,
      compactionsThisTurn: 0,
    };
    this.context.logger.debug(
      {
        event: "context_accounting",
        providerId: route.providerId,
        modelId: route.modelId,
        capacitySource: capacity.source,
        usageSource: usage.source,
        estimated: usage.estimated,
        usedTokens,
        hardPromptBudget: budget.hardPromptBudget,
        compactAtTokens: budget.compactAtTokens,
      },
      "context accounting"
    );
    return status;
  }

  private incrementSessionCompactions(session: SessionHandle | undefined): number {
    const key = session?.sessionId ?? `workspace:${this.context.workspaceRoot}`;
    const next = (this.contextCompactionsBySession.get(key) ?? 0) + 1;
    this.contextCompactionsBySession.set(key, next);
    return next;
  }

  private async runStructuredPreCompactHook(
    status: ContextStatus,
    reason: "manual" | "threshold" | "overflow" | "model-switch",
    focus: string | undefined,
    session: SessionHandle | undefined,
    abortSignal: AbortSignal | undefined
  ): Promise<{ events: AgentRuntimeEvent[]; result: HookRunResult }> {
    const events: AgentRuntimeEvent[] = [];
    const result = await this.runHookEvent(
      "PreCompact",
      this.createBaseHookPayload("PreCompact", session, {
        reason,
        mode: reason === "manual" ? "manual" : "automatic",
        ...(focus?.trim() ? { focus: focus.trim() } : {}),
        route: status.route,
        usage: {
          usedTokens: status.budget.usedTokens,
          estimated: status.usage.estimated,
        },
        budget: {
          contextWindow: status.budget.capacity.contextWindow,
          hardPromptBudget: status.budget.hardPromptBudget,
          compactAtTokens: status.budget.compactAtTokens,
          targetTokens: status.budget.targetTokens,
          capacitySource: status.budget.capacity.source,
        },
      }),
      {
        abortSignal,
        onHookStart: (hookStatus) => {
          events.push(agentEvent.hookStatus(hookStatus.event, hookStatus.statusMessage));
        },
      }
    );
    events.push(...this.hookResultToEvents(result));
    return { events, result };
  }

  private async summarizeConversationProjection(
    conversation: readonly ConversationTurn[],
    options: { focus?: string; abortSignal?: AbortSignal }
  ): Promise<ReturnType<typeof compactConversationDeterministically>> {
    const policy = contextPolicyFromConfig(this.context.config);
    const compacted = compactConversationDeterministically(conversation, {
      keepRecentTokens: policy.keepRecentTokens,
      ...(options.focus?.trim() ? { focus: options.focus.trim() } : {}),
    });
    if (conversation.length <= 4 || !compacted.projection.summary) return compacted;
    const recentCount = compacted.projection.segments.filter(
      (segment) => segment.kind === "inline" && segment.segmentKind === "turn"
    ).length;
    const older = conversation.slice(0, Math.max(0, conversation.length - recentCount));
    const chunks = chunkConversationTurns(older, 18_000);
    let summaries: string[] = [];
    const summarySystem =
      "Create a compact, factual handoff. Use headings: Goal; User constraints and preferences; Decisions and rationale; Completed work; Current work and blockers; Files read or changed; Exact identifiers, commands, errors, and verification results; Settled tool outcomes and continuation state; Next steps. Preserve exact identifiers, paths, commands, errors, mutations, validation results, constraints, and next steps. Do not invent facts.";
    try {
      for (const chunk of chunks) {
        const result = await this.context.modelGateway.generateText({
          purpose: "agent.primary",
          system: summarySystem,
          prompt: [
            options.focus?.trim() ? `Compaction focus:\n${options.focus.trim()}` : "",
            "Conversation to compact:",
            chunk.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n\n"),
          ]
            .filter(Boolean)
            .join("\n\n"),
          abortSignal: options.abortSignal,
        });
        if (result.text.trim()) summaries.push(result.text.trim());
      }
      for (
        let foldPass = 0;
        summaries.length > 1 && estimateTextTokens(summaries.join("\n\n")) > 18_000 && foldPass < 3;
        foldPass += 1
      ) {
        const folded: string[] = [];
        for (const group of chunkTexts(summaries, 18_000)) {
          const result = await this.context.modelGateway.generateText({
            purpose: "agent.primary",
            system: summarySystem,
            prompt: [
              options.focus?.trim() ? `Compaction focus:\n${options.focus.trim()}` : "",
              "Partial handoffs to merge without losing exact evidence:",
              group.join("\n\n--- partial handoff ---\n\n"),
            ]
              .filter(Boolean)
              .join("\n\n"),
            abortSignal: options.abortSignal,
          });
          if (result.text.trim()) folded.push(result.text.trim());
        }
        if (folded.length === 0 || folded.join("\n\n") === summaries.join("\n\n")) break;
        summaries = folded;
      }
      if (summaries.length > 0) compacted.projection.summary = summaries.join("\n\n");
    } catch (error) {
      this.context.logger.warn(
        {
          event: "context_summary_fallback",
          error: error instanceof Error ? error.message : String(error),
          chunkCount: chunks.length,
        },
        "context summary generation failed; using deterministic handoff"
      );
    }
    compacted.afterTokens = estimateTextTokens(
      `${compacted.projection.summary ?? ""}\n\n${projectionToConversationTurns(compacted.projection, [])
        .map((turn) => `${turn.role}: ${turn.text}`)
        .join("\n\n")}`
    );
    return compacted;
  }

  private resolveModelMetadata(
    purpose: ModelPurpose
  ): ReturnType<AppContext["modelGateway"]["resolveModel"]> | undefined {
    const gateway = this.context.modelGateway;

    if (typeof gateway.resolveModel !== "function") {
      return undefined;
    }

    try {
      return gateway.resolveModel(purpose);
    } catch (error) {
      this.context.logger.debug(
        {
          event: "model_resolution_skipped",
          purpose,
          error: error instanceof Error ? error.message : String(error),
        },
        "model metadata unavailable"
      );

      return undefined;
    }
  }

  private createToolHookPayload(
    event: HookRunPayload["event"],
    call: ToolCall,
    toolCallId: string | undefined,
    session: SessionHandle | undefined,
    extra: Record<string, unknown> = {}
  ): HookRunPayload {
    return this.createBaseHookPayload(event, session, {
      tool_name: call.tool,
      tool_input: call.args,
      tool: {
        name: call.tool,
        input: call.args,
        ...(toolCallId ? { callId: toolCallId } : {}),
      },
      ...extra,
    });
  }

  private hookResultToEvents(result: HookRunResult): AgentRuntimeEvent[] {
    return result.messages.map((message) => agentEvent.systemMessage(message));
  }

  private async resolveBaseProjectInstructions(): Promise<ProjectInstructionContext> {
    return resolveProjectInstructions(this.context.workspaceRoot, {
      ...this.context.config.instructions,
      logger: this.context.logger,
    });
  }

  private buildSystemPromptWithProjectInstructions(
    options: Parameters<typeof getChatSystemPrompt>[0],
    instructions: ProjectInstructionContext
  ): string {
    const system = getChatSystemPrompt(options);

    return instructions.formatted ? `${system}\n\n${instructions.formatted}` : system;
  }

  private async resolveBashApproval(
    call: ToolCall,
    toolCallId: string | undefined,
    options: AgentRuntimeSubmitMessageOptions,
    session: SessionHandle | undefined,
    abortSignal: AbortSignal | undefined
  ): Promise<
    | { cancelled: false; approvedCommands: string[]; events: AgentRuntimeEvent[] }
    | { cancelled: true; stopped?: false; reason: string; events: AgentRuntimeEvent[] }
    | { cancelled: true; stopped: true; reason: string; events: AgentRuntimeEvent[] }
  > {
    const approvedCommands = [...this.approvedBashCommands];

    if (call.tool !== "bash") {
      return { cancelled: false, approvedCommands, events: [] };
    }

    const parsed = bashArgsSchema.safeParse(call.args);

    if (!parsed.success) {
      return { cancelled: false, approvedCommands, events: [] };
    }

    const decision = await validateBashPolicy(parsed.data, {
      workspaceRoot: this.context.workspaceRoot,
      permissions: this.context.config.tools?.bash,
      approvedCommands,
    });

    if (decision.allowed) {
      return { cancelled: false, approvedCommands, events: [] };
    }

    if (!isBashApprovalRequired(decision)) {
      return { cancelled: false, approvedCommands, events: [] };
    }

    const approvalMode = options.userApprovalMode ?? "interactive";

    if (approvalMode !== "auto_allow" && !options.requestBashApproval) {
      return { cancelled: false, approvedCommands, events: [] };
    }

    const command = decision.commands[0] ?? parsed.data.command.trim();
    const actionRequiredHook = await this.runHookEvent(
      "PermissionRequest",
      this.createToolHookPayload("PermissionRequest", call, toolCallId, session, {
        notification_type: "permission_prompt",
        permission_mode: "bash",
        command,
        workdir: parsed.data.workdir,
        reason: decision.reason,
        ...(approvalMode === "auto_allow" ? { approval_mode: "auto_allow", auto_approved: true } : {}),
      }),
      { toolName: call.tool, abortSignal }
    );
    const events = this.hookResultToEvents(actionRequiredHook);

    if (actionRequiredHook.stopped) {
      return {
        cancelled: true,
        stopped: true,
        reason: actionRequiredHook.stopped.message,
        events,
      };
    }

    if (actionRequiredHook.blocked) {
      const interruption = actionRequiredHook.blocked;

      return {
        cancelled: true,
        reason: interruption.message,
        events,
      };
    }

    if (approvalMode === "auto_allow") {
      const event = agentEvent.permissionAutoApproved({
        permissionMode: "bash",
        toolName: call.tool,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        command,
        workdir: parsed.data.workdir,
        reason: decision.reason,
      });

      this.context.logger.info(
        {
          event: "permission_auto_approved",
          approvalMode: "auto_allow",
          permissionMode: "bash",
          toolName: call.tool,
          toolCallId,
          command,
          workdir: parsed.data.workdir,
          reason: decision.reason,
        },
        "permission request auto-approved"
      );

      return { cancelled: false, approvedCommands: [...approvedCommands, command], events: [...events, event] };
    }

    if (!options.requestBashApproval) {
      return { cancelled: false, approvedCommands, events };
    }

    const approval = await options.requestBashApproval({
      command,
      workdir: parsed.data.workdir,
      reason: decision.reason,
      candidates: decision.candidates ?? { exact: [command], prefix: [] },
    });

    if (approval === "cancel") {
      return {
        cancelled: true,
        reason: `bash cancelled by user for '${command}'.`,
        events,
      };
    }

    if (approval === "allow_session" || approval === "allow_repo") {
      this.approvedBashCommands.add(command);
      return { cancelled: false, approvedCommands: [...this.approvedBashCommands], events };
    }

    return { cancelled: false, approvedCommands: [...approvedCommands, command], events };
  }

  /**
   * Executes a slash command through the shared command dispatcher and maps
   * the command output into runtime events. Commands that can change KB
   * readiness also refresh the displayed knowledge status so the TUI footer
   * and chat status stay aligned with the command result.
   */
  async submitSlashCommand(
    command: string,
    onProgress?: KnowledgeProgressReporter,
    abortSignal?: AbortSignal
  ): Promise<AgentRuntimeEvent[]> {
    const result = await executeSlashCommand(command, {
      workspaceRoot: this.context.workspaceRoot,
      config: this.context.config,
      modelGateway: this.context.modelGateway,
      onProgress,
      abortSignal,
      formatSyncStatus: formatTuiSyncStatus,
    });
    const parsed = parseSlashCommand(command);
    if (parsed?.name === "kb" && parsed.args[0] === "live" && ["on", "off"].includes(parsed.args[1] ?? "")) {
      reloadAppBaseConfig(this.context);
      if (this.context.config.knowledge?.live) this.liveL1Scheduler.start();
      else this.liveL1Scheduler.stop();
    }
    const events: AgentRuntimeEvent[] = [agentEvent.systemMessage(result.messages.join("\n"))];

    if (shouldRefreshKnowledgeStatus(command)) {
      events.push(agentEvent.knowledgeStatus(await this.getKnowledgeStatusWithNonCleanFileCount()));
    }

    events.push(agentEvent.status("ready"));

    return events;
  }

  /**
   * Reads the project KB status and augments it with a count of files that
   * would be touched by a dry-run compile. The dry run is only performed for
   * a ready KB directory, because missing or incomplete KB states already
   * have enough information for the startup and status messages.
   */
  private async getKnowledgeStatusWithNonCleanFileCount(): Promise<KnowledgeStatus> {
    const status = getKnowledgeStatus(this.context.workspaceRoot);

    if (this.context.config.knowledge?.live) {
      return { ...status, liveSync: this.liveL1Scheduler.snapshot() };
    }

    if (!status.kbExists || !status.kbIsDirectory || status.kbContentState !== "ready") {
      return status;
    }

    const result = filterNonCleanKnowledgeCompileResult(
      await dryRunKnowledgeCompile(this.context.workspaceRoot, { config: this.context.config })
    );

    return { ...status, nonCleanFileCount: result.files.length };
  }

  /**
   * Adds relevant L1 knowledge context to the conversation prompt when the
   * compiled KB is present and ready. Search failures are logged and then
   * ignored on purpose: stale or broken KB search should not prevent the
   * user's chat turn from reaching the model.
   */
  private async buildPromptSegmentsWithKnowledgeContext(prompt: string, message: string): Promise<PromptSegment[]> {
    const conversation = (): PromptSegment[] => [{ kind: "conversation", text: prompt, retention: "required" }];
    if (this.options.disableL1Context ?? isL1ContextDisabledByEnv()) {
      this.context.logger.debug(
        {
          event: "kb_context_pack_skipped",
          reason: "disabled",
        },
        "kb context pack skipped"
      );

      return conversation();
    }

    const status = getKnowledgeStatus(this.context.workspaceRoot);

    if (!status.kbExists || !status.kbIsDirectory || status.kbContentState !== "ready") {
      return conversation();
    }

    try {
      const contextPack = await createL1ContextPack(this.context.workspaceRoot, message, { limit: 8, minScore: 12 });

      this.context.logger.debug(
        {
          event: "kb_context_pack",
          query: message,
          entryCount: contextPack.entryCount,
          relevantFileCount: contextPack.relevantFiles.length,
          paths: contextPack.relevantFiles.map((file) => file.path),
          warnings: contextPack.warnings,
        },
        "kb context pack"
      );
      this.context.logger.trace(
        {
          event: "kb_context_pack_payload",
          contextPack,
        },
        "kb context pack payload"
      );

      if (contextPack.relevantFiles.length === 0) {
        return conversation();
      }

      return [
        {
          kind: "knowledge",
          text: `${formatL1ContextPackForPrompt(contextPack)}\n\nConversation:`,
          retention: "required",
        },
        { kind: "conversation", text: prompt, retention: "required", separatorBefore: "\n" },
      ];
    } catch (error) {
      this.context.logger.debug(
        {
          event: "kb_context_pack_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "kb context pack failed"
      );

      return conversation();
    }
  }
}

function createToolErrorResult(tool: ToolCall["tool"], message: string): ToolExecutionResult<ToolResult> {
  return {
    tool,
    content: `Tool ${tool} failed: ${message}`,
    error: message,
    warning: message,
  };
}

function getToolCallDisplayDiff(result: ToolExecutionResult<ToolResult>): string | undefined {
  if (result.tool === "edit_file" && !isToolErrorResult(result) && "diff" in result) {
    return result.diff;
  }

  if (result.tool === "apply_patch" && !isToolErrorResult(result) && result.diffs.length > 0) {
    return result.diffs.join("\n");
  }

  return undefined;
}

function readMaxToolCallsPerTurn(): number {
  const raw = process.env[MAX_TOOL_CALLS_PER_TURN_ENV]?.trim();
  if (!raw) {
    return DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  }

  if (["0", "off", "false", "none", "unlimited", "disabled"].includes(raw.toLowerCase())) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  }

  return parsed;
}

function readPlanTodoMode(): PlanTodoMode {
  const raw = process.env[PLAN_TODO_MODE_ENV]?.trim().toLowerCase();
  return raw === "compact" ? "compact" : "normal";
}

function readMaxPlanTodoUpdatesPerTurn(mode: PlanTodoMode): number | undefined {
  const raw = process.env[MAX_PLAN_TODO_UPDATES_PER_TURN_ENV]?.trim();
  if (!raw) {
    return mode === "compact" ? DEFAULT_COMPACT_MAX_PLAN_TODO_UPDATES_PER_TURN : undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return mode === "compact" ? DEFAULT_COMPACT_MAX_PLAN_TODO_UPDATES_PER_TURN : undefined;
  }

  return parsed;
}

function validatePlanTodoCall(
  call: ToolCall,
  currentPlan: TaskPlanState,
  state: {
    afterTool: ToolCall["tool"] | undefined;
    planTodoUpdates: number;
    maxPlanTodoUpdatesPerTurn: number | undefined;
  }
): string | undefined {
  if (call.tool !== "plan_todo") {
    return undefined;
  }

  const allCompleted = isAllCompletedPlanTodoCall(call.args);

  if (state.afterTool === "plan_todo" && !allCompleted) {
    return "plan_todo rejected because the previous tool call was also plan_todo. Batch checklist updates and proceed with repository work.";
  }

  if (state.maxPlanTodoUpdatesPerTurn !== undefined && state.planTodoUpdates >= state.maxPlanTodoUpdatesPerTurn) {
    return `plan_todo rejected because this turn already used ${state.planTodoUpdates} plan update(s), which meets the configured limit of ${state.maxPlanTodoUpdatesPerTurn}. Continue with repository work and summarize progress in the final response.`;
  }

  if (isSamePlanTodoItems(call.args, currentPlan) && !allCompleted) {
    return "plan_todo rejected because it does not change the visible plan. Continue with the next substantive tool call or final response.";
  }

  return undefined;
}

function isAllCompletedPlanTodoCall(args: unknown): boolean {
  const items = (args as { items?: unknown }).items;
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => {
      return Boolean(
        item && typeof item === "object" && "status" in item && (item as { status?: unknown }).status === "completed"
      );
    })
  );
}

function isSamePlanTodoItems(args: unknown, currentPlan: TaskPlanState): boolean {
  const items = (args as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== currentPlan.items.length) {
    return false;
  }

  return items.every((item, index) => {
    const current = currentPlan.items[index];
    if (!current || typeof item !== "object" || item === null) {
      return false;
    }

    const candidate = item as { text?: unknown; status?: unknown };
    return candidate.text === current.text && candidate.status === current.status;
  });
}

function isL1ContextDisabledByEnv(): boolean {
  const value = process.env.TOPCHESTER_DISABLE_L1_CONTEXT?.trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function summarizeProjectInstructionSources(instructions: ProjectInstructionContext): Array<{
  path: string;
  scopePath: string;
  bytes: number;
  truncated: boolean;
}> {
  return instructions.sources.map((source) => ({
    path: source.relativePath,
    scopePath: source.scopePath,
    bytes: source.bytes,
    truncated: source.truncated,
  }));
}

function createInstructionContextEventsFromProjectInstructions(
  instructions: ProjectInstructionContext,
  persistedKeys: Set<string>
): AgentRuntimeEvent[] {
  return createInstructionContextEvents(
    instructions.sources.map((source) => ({
      path: source.relativePath,
      scopePath: source.scopePath,
      bytes: source.bytes,
      truncated: source.truncated,
    })),
    persistedKeys
  );
}

function createInstructionContextEventsFromToolResult(
  result: ToolExecutionResult<ToolResult>,
  persistedKeys: Set<string>
): AgentRuntimeEvent[] {
  if (isToolErrorResult(result) || !("projectInstructions" in result) || !result.projectInstructions) {
    return [];
  }

  return createInstructionContextEvents(
    result.projectInstructions.sources.map((source) => ({
      path: source.relativePath,
      scopePath: source.scopePath,
      bytes: source.bytes,
      truncated: source.truncated,
    })),
    persistedKeys
  );
}

function createInstructionContextEvents(
  sources: AgentInstructionContextSource[],
  persistedKeys: Set<string>
): AgentRuntimeEvent[] {
  const newSources = sources.filter((source) => !persistedKeys.has(source.path));

  if (newSources.length === 0) {
    return [];
  }

  for (const source of newSources) {
    persistedKeys.add(source.path);
  }

  return [agentEvent.instructionContext(newSources)];
}
