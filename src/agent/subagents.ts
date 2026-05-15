import { type AppContext } from "../app/context.js";
import { runtimeEventToSessionPayload } from "../session/runtime-payloads.js";
import { createChildSession, type SessionHandle } from "../session/store.js";
import { type ConversationTurn } from "./conversation.js";
import { agentEvent, type AgentRuntimeEvent } from "./events.js";
import { resolveAgentProfile, type AgentProfile, type ToolPermissionView } from "./profiles.js";

export interface SubagentRuntime {
  submitMessageStream(
    conversation: ConversationTurn[],
    message: string,
    abortSignal?: AbortSignal,
    options?: { session?: SessionHandle }
  ): AsyncIterable<AgentRuntimeEvent>;
}

export interface SubagentManagerOptions {
  context: AppContext;
  parentSession?: SessionHandle;
  parentProfile: AgentProfile;
  parentPermissions: ToolPermissionView;
  createRuntime(options: {
    profile: AgentProfile;
    parentPermissions: ToolPermissionView;
    session: SessionHandle;
  }): SubagentRuntime;
}

export interface RunSubagentTaskOptions {
  description: string;
  prompt: string;
  subagentType?: string;
  taskId?: string;
  parentToolCallId: string;
  eventSink?: (event: AgentRuntimeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export interface SubagentTaskRunResult {
  sessionId: string;
  status: "completed" | "failed";
  result: string;
  profileId: string;
}

export class SubagentManager {
  constructor(private readonly options: SubagentManagerOptions) {}

  async runTask(options: RunSubagentTaskOptions): Promise<SubagentTaskRunResult> {
    const parentSession = this.options.parentSession;

    if (!parentSession) {
      throw new Error("task requires an active persisted session.");
    }

    const profile = resolveAgentProfile(options.subagentType ?? "explore");
    if (profile.mode !== "subagent" && profile.mode !== "all") {
      throw new Error(`Agent profile "${profile.id}" cannot be used for subagent tasks.`);
    }

    const child = await createChildSession(this.options.context.workspaceRoot, {
      parent: parentSession,
      parentToolCallId: options.parentToolCallId,
      agentProfileId: profile.id,
      title: options.description,
      recordParentEvent: false,
    });
    const reference = {
      sessionId: child.sessionId,
      parentSessionId: parentSession.sessionId,
      parentToolCallId: options.parentToolCallId,
    };

    await options.eventSink?.(
      agentEvent.subagentStarted({
        ...reference,
        agentProfileId: profile.id,
        title: options.description,
      })
    );

    const childRuntime = this.options.createRuntime({
      profile,
      parentPermissions: this.options.parentPermissions,
      session: child,
    });
    let finalResponse = "";

    try {
      for await (const childEvent of childRuntime.submitMessageStream([], options.prompt, options.abortSignal, {
        session: child,
      })) {
        const payload = runtimeEventToSessionPayload(childEvent);
        if (payload) {
          await child.append(payload);
        }
        if (childEvent.type === "message" && childEvent.role === "assistant") {
          finalResponse = childEvent.text;
        }
        await options.eventSink?.(agentEvent.subagentEvent(reference, childEvent));
      }

      const result = finalResponse.trim() || "Subagent completed without an assistant response.";
      await options.eventSink?.(agentEvent.subagentCompleted({ ...reference, result }));

      return {
        sessionId: child.sessionId,
        status: "completed",
        result,
        profileId: profile.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.eventSink?.(agentEvent.subagentFailed({ ...reference, error: message }));

      return {
        sessionId: child.sessionId,
        status: "failed",
        result: message,
        profileId: profile.id,
      };
    }
  }
}
