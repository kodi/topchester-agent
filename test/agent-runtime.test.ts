import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AppContext } from "../src/app/context.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime/index.js";

describe("agent runtime project instructions", () => {
  it("injects root project instructions into the system prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENTS.md"), "Answer in short sentences.\n");
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("You are Topchester");
    expect(systems[0]).toContain("# AGENTS.md instructions");
    expect(systems[0]).toContain("## AGENTS.md for .");
    expect(systems[0]).toContain("Answer in short sentences.");
  });

  it("omits the project instruction block when no instruction file exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain("# AGENTS.md instructions");
  });

  it("reports compact startup project instruction status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENTS.override.md"), "Local instruction.\n");
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkProjectInstructions();

    expect(events).toEqual([
      {
        type: "message",
        role: "system",
        text: "Project instructions: AGENTS.override.md",
      },
    ]);
  });
});

function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
    config: {},
    modelGateway: {
      async generateText() {
        throw new Error("model should not be called for this test");
      },
    } as unknown as AppContext["modelGateway"],
    devFlags: new Set(),
    logger: {
      debug() {},
      trace() {},
      error() {},
    } as unknown as AppContext["logger"],
  };
}
