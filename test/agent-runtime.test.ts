import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("feeds nested project instructions back before retrying a scoped edit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Use src naming rules.\n");
    await writeFile(join(workspace, "src", "value.txt"), "enabled=false\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("+enabled=true")) {
            return {
              text: "Edited.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "edit_file",
              args: {
                path: "src/value.txt",
                edits: [{ old_text: "enabled=false\n", new_text: "enabled=true\n" }],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "turn it on");

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("edit_file did not change src/value.txt.");
    expect(prompts[1]).toContain("Use src naming rules.");
    expect(prompts[2]).toContain("+enabled=true");
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("enabled=true\n");
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
