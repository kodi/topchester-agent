import { type AppContext } from "../src/app/context.js";

export function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
    configLoadSpec: { workspaceRoot },
    baseConfig: {},
    runtimeConfigOverrides: { reasoningEffortByProvider: {} },
    config: {},
    devFlags: new Set(),
    modelGateway: {
      async generateText() {
        return {
          text: "ready",
          providerId: "fake",
          modelId: "fake-agent",
          purpose: "agent.primary" as const,
        };
      },
    } as unknown as AppContext["modelGateway"],
    logger: {
      child() {
        return this;
      },
      debug() {},
      trace() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as AppContext["logger"],
  };
}
