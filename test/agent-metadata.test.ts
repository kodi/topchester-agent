import { describe, expect, it } from "vite-plus/test";
import { agentMetadataSchema, agentsMetadata, getAgentMetadata, listAgentMetadata } from "../src/agent/metadata.js";

describe("agent metadata", () => {
  it("loads checked-in agents.json metadata by agent id", () => {
    expect(getAgentMetadata("codex")).toMatchObject({
      display_name: "Codex",
      description: expect.stringContaining("OpenAI coding agent"),
      external_url: "https://openai.com/codex",
      source_url: "https://github.com/openai/codex",
    });
  });

  it("keeps required fields small and model metadata optional", () => {
    expect(agentMetadataSchema.parse({ display_name: "Example", description: "Example agent." })).toEqual({
      display_name: "Example",
      description: "Example agent.",
    });

    expect(agentsMetadata.agents.codex?.model_support).toMatchObject({
      providers: ["openai"],
      requirements: {
        tool_calling: true,
        streaming: true,
        reasoning: true,
      },
    });
  });

  it("lists metadata in stable id order", () => {
    expect(listAgentMetadata().map((entry) => entry.id)).toEqual(["codex", "topchester"]);
  });
});
