import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { cwd } from "node:process";
import { parseSlashCommand } from "../agent/commands.js";
import { type BenchmarkProfile } from "../agent/benchmark-profile.js";
import { type ConversationTurn } from "../agent/conversation.js";
import { type AgentRuntimeEvent } from "../agent/events.js";
import { TopchesterAgentRuntime } from "../agent/runtime/index.js";
import { formatTaskPlanNotice } from "../agent/task-plan.js";
import { type AppContext } from "../app/context.js";
import { createHerdrAgentReporter } from "../integrations/herdr.js";
import { createStartupTranscriptEntry } from "../chat/index.js";
import {
  createSession,
  loadSession,
  loadSessionForAppend,
  rehydrateSession,
  type SessionHandle,
} from "../session/store.js";
import { runtimeEventToSessionPayload as runtimeEventToSessionPayloadFromSession } from "../session/runtime-payloads.js";
import { slashCommandToSessionPayload, transcriptEntryToSessionPayload } from "../session/transcript-payloads.js";

export interface RunCommandOptions {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  json?: boolean;
  outputJson?: string;
  resume?: string;
  dangerouslyAutoApprove?: boolean;
  benchmarkProfile?: BenchmarkProfile;
}

interface RunJsonEvent {
  type: string;
  runId: string;
  sessionId: string;
  ts: string;
  [key: string]: unknown;
}

export async function executeRunCommand(context: AppContext, options: RunCommandOptions): Promise<void> {
  const runId = randomUUID();
  const runContext = withRunContext(withModelOverride(context, options.model), runId);
  const runtime = new TopchesterAgentRuntime(runContext);
  const jsonEvents: RunJsonEvent[] = [];
  const session = await resolveRunSession(runContext.workspaceRoot, options.resume);
  const herdrReporter = createHerdrAgentReporter();
  const conversation = options.resume ? await loadConversation(runContext.workspaceRoot, options.resume) : [];
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs;
  const abortController = new AbortController();
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          abortController.abort();
        }, timeoutMs);

  runContext.logger.info(
    {
      event: "run_started",
      workspaceRoot: runContext.workspaceRoot,
      sessionId: session.sessionId,
      promptLength: options.prompt.length,
      json: Boolean(options.json),
      outputJson: options.outputJson,
      timeoutMs,
      dangerouslyAutoApprove: Boolean(options.dangerouslyAutoApprove),
      benchmarkProfile: options.benchmarkProfile,
    },
    "run started"
  );
  pushJson(jsonEvents, runId, session.sessionId, "run.started", {
    workspaceRoot: runContext.workspaceRoot,
    timeoutMs,
    dangerouslyAutoApprove: Boolean(options.dangerouslyAutoApprove),
    benchmarkProfile: options.benchmarkProfile,
  });

  try {
    await herdrReporter.report({ state: "working", sessionId: session.sessionId });
    if (!options.resume) {
      await persistStartupMessages(session, runContext);
    }

    await applyRuntimeEvents({
      events: await runtime.runSessionStartHooks(session, {
        isResumed: Boolean(options.resume),
        abortSignal: abortController.signal,
      }),
      session,
      jsonEvents,
      runId,
      plain: !options.json,
    });

    await applyRuntimeEvents({
      events: (await runtime.checkProjectInstructions?.()) ?? [],
      session,
      jsonEvents,
      runId,
      plain: !options.json,
    });

    await applyRuntimeEvents({
      events: await runtime.checkKnowledgeBase(),
      session,
      jsonEvents,
      runId,
      plain: !options.json,
    });

    if (parseSlashCommand(options.prompt)) {
      runContext.logger.info({ event: "slash_command_dispatch", command: options.prompt }, "slash command dispatch");
      await session.append(slashCommandToSessionPayload(options.prompt));
      pushJson(jsonEvents, runId, session.sessionId, "user.message", {
        text: options.prompt,
        inputType: "slash_command",
      });
      await applyRuntimeEvents({
        events: await runtime.submitSlashCommand(options.prompt, undefined, abortController.signal),
        session,
        jsonEvents,
        runId,
        plain: !options.json,
      });
    } else {
      await session.append({ kind: "message", role: "user", text: options.prompt });
      pushJson(jsonEvents, runId, session.sessionId, "user.message", { text: options.prompt, inputType: "prompt" });
      for await (const event of runtime.submitMessageStream(conversation, options.prompt, abortController.signal, {
        session,
        userApprovalMode: options.dangerouslyAutoApprove ? "auto_allow" : "interactive",
        benchmarkProfile: options.benchmarkProfile,
      })) {
        await applyRuntimeEvent({
          event,
          session,
          jsonEvents,
          runId,
          plain: !options.json,
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    runContext.logger.info({ event: "run_finished", sessionId: session.sessionId, durationMs }, "run finished");
    pushJson(jsonEvents, runId, session.sessionId, "session.persisted", { sessionDir: session.sessionDir });
    pushJson(jsonEvents, runId, session.sessionId, "run.finished", { durationMs });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }

    try {
      await writeJsonEvents(jsonEvents, options);
    } finally {
      await herdrReporter.release();
    }
  }
}

function withRunContext(context: AppContext, runId: string): AppContext {
  return {
    ...context,
    logger: context.logger.child({ runId }),
  };
}

function withModelOverride(context: AppContext, model: string | undefined): AppContext {
  if (!model) {
    return context;
  }

  return {
    ...context,
    modelGateway: context.modelGateway.withModelOverride(model),
  };
}

async function resolveRunSession(workspaceRoot: string, resume: string | undefined): Promise<SessionHandle> {
  if (!resume) {
    return createSession(workspaceRoot);
  }

  const loaded = await loadSession(workspaceRoot, resume);
  return loadSessionForAppend(workspaceRoot, loaded.sessionId);
}

async function loadConversation(workspaceRoot: string, resume: string): Promise<ConversationTurn[]> {
  const loaded = await loadSession(workspaceRoot, resume);
  const rehydrated = rehydrateSession(loaded.events);

  return rehydrated.transcript.flatMap((entry): ConversationTurn[] => {
    switch (entry.kind) {
      case "user":
        return entry.modelContext === false ? [] : [{ role: "user", text: entry.text }];
      case "assistant":
        return entry.modelContext === false ? [] : [{ role: "assistant", text: entry.text }];
      case "system":
      case "reasoning":
      case "tool_call":
      case "hook_status":
      case "subagent":
      case "choice":
      case "permission_auto_approved":
      case "knowledge_status":
      case "startup":
        return [];
    }
  });
}

async function persistStartupMessages(session: SessionHandle, context: AppContext): Promise<void> {
  const payload = transcriptEntryToSessionPayload(createStartupTranscriptEntry(context));

  if (payload) {
    await session.append(payload);
  }
}

async function applyRuntimeEvents(options: {
  events: AgentRuntimeEvent[];
  session: SessionHandle;
  jsonEvents: RunJsonEvent[];
  runId: string;
  plain: boolean;
}): Promise<void> {
  for (const event of options.events) {
    await applyRuntimeEvent({ ...options, event });
  }
}

async function applyRuntimeEvent(options: {
  event: AgentRuntimeEvent;
  session: SessionHandle;
  jsonEvents: RunJsonEvent[];
  runId: string;
  plain: boolean;
}): Promise<void> {
  const payload = runtimeEventToSessionPayloadFromSession(options.event);

  if (payload) {
    await options.session.append(payload);
  }

  pushJson(options.jsonEvents, options.runId, options.session.sessionId, options.event.type, { event: options.event });

  if (options.plain) {
    printPlainEvent(options.event);
  }
}

function printPlainEvent(event: AgentRuntimeEvent): void {
  if (event.type === "message") {
    console.log(event.text);
    return;
  }

  if (event.type === "permission_auto_approved") {
    console.log(event.label);
    return;
  }

  if (event.type === "tool_call") {
    console.log(event.label);
    return;
  }

  if (event.type === "hook_status") {
    console.log(event.label);
    return;
  }

  if (event.type === "knowledge_status" && event.guidance) {
    console.log(event.guidance);
    return;
  }

  if (event.type === "task_plan") {
    const notice = formatTaskPlanNotice("updated", event.plan);

    if (notice) {
      console.log(notice);
    }
  }
}

function pushJson(
  events: RunJsonEvent[],
  runId: string,
  sessionId: string,
  type: string,
  fields: Record<string, unknown>
) {
  events.push({
    type,
    runId,
    sessionId,
    ts: new Date().toISOString(),
    ...fields,
  });
}

async function writeJsonEvents(events: RunJsonEvent[], options: RunCommandOptions): Promise<void> {
  if (!options.json && !options.outputJson) {
    return;
  }

  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

  if (options.json) {
    process.stdout.write(content);
  }

  if (options.outputJson) {
    const path = isAbsolute(options.outputJson) ? options.outputJson : resolve(cwd(), options.outputJson);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
