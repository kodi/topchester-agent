import { describe, expect, it } from "vite-plus/test";
import { classifyContextOverflow } from "../src/agent/context/overflow.js";

describe("context overflow classification", () => {
  it("prefers structured codes and extracts exact numeric maxima", () => {
    expect(
      classifyContextOverflow({
        status: 400,
        code: "context_length_exceeded",
        message: "This model's maximum context length is 128,000 tokens; you sent 140,000 tokens.",
      })
    ).toEqual({
      overflow: true,
      maximumTokens: 128_000,
      requestedTokens: 140_000,
      source: "reported",
      providerCode: "context_length_exceeded",
    });
  });

  it("does not learn unrelated numbers from generic failures", () => {
    expect(classifyContextOverflow(new Error("HTTP 500 after 128000 milliseconds"))).toEqual({ overflow: false });
  });

  it("keeps capacity unknown when overflow has no numeric contract", () => {
    expect(classifyContextOverflow(new Error("Prompt is too long for this context window"))).toEqual({
      overflow: true,
    });
  });

  it("recognizes nested provider error bodies", () => {
    expect(
      classifyContextOverflow({
        statusCode: 400,
        data: { error: { code: "context_length_exceeded", message: "limit 8192 tokens" } },
      })
    ).toMatchObject({ overflow: true, maximumTokens: 8192, providerCode: "context_length_exceeded" });
  });
});
