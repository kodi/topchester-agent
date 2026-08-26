import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCapacityRegistry } from "../src/agent/context/registry.js";

describe("context capacity registry", () => {
  it("persists learned provider limits atomically for the exact normalized route", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-context-routes-"));
    const route = { providerId: "Proxy", baseURL: "HTTPS://PROXY.TEST/v1/", modelId: "model-a" };
    const registry = new ContextCapacityRegistry(workspace);
    registry.set(route, {
      maxInputTokens: 80_000,
      source: "error-reported",
      confidence: "reported",
      observedAt: "2026-08-26T00:00:00.000Z",
    });

    const path = join(workspace, ".agents", "topchester", "context-routes.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      expect.objectContaining({ version: 1, routes: expect.any(Object) })
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(new ContextCapacityRegistry(workspace).get(route, Date.parse("2026-08-27T00:00:00.000Z"))).toEqual(
      expect.objectContaining({ maxInputTokens: 80_000, source: "error-reported" })
    );
    expect(
      new ContextCapacityRegistry(workspace).get(
        { ...route, baseURL: "https://other-proxy.test/v1" },
        Date.parse("2026-08-27T00:00:00.000Z")
      )
    ).toBeUndefined();
  });

  it("does not persist config, assumed, or expired capacity as learned route truth", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-context-routes-policy-"));
    const route = { providerId: "proxy", baseURL: "https://proxy.test/v1", modelId: "model-a" };
    const registry = new ContextCapacityRegistry(workspace, 1_000);
    registry.set(route, { contextWindow: 100_000, source: "config", confidence: "authoritative" });
    expect(registry.get(route)).toBeUndefined();

    registry.set(route, {
      contextWindow: 90_000,
      source: "provider",
      confidence: "reported",
      observedAt: "2026-08-26T00:00:00.000Z",
    });
    expect(registry.get(route, Date.parse("2026-08-26T00:00:02.000Z"))).toBeUndefined();
  });

  it("keeps a learned ceiling as a non-raising cap when fresh provider metadata arrives", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-context-routes-cap-"));
    const route = { providerId: "proxy", baseURL: "https://proxy.test/v1", modelId: "model-a" };
    const registry = new ContextCapacityRegistry(workspace);
    registry.set(route, {
      maxInputTokens: 80_000,
      source: "error-reported",
      confidence: "reported",
      observedAt: "2026-08-26T00:00:00.000Z",
    });
    registry.set(route, {
      contextWindow: 128_000,
      source: "provider",
      confidence: "reported",
      observedAt: "2026-08-26T00:01:00.000Z",
    });

    expect(registry.get(route, Date.parse("2026-08-26T00:02:00.000Z"))).toMatchObject({
      contextWindow: 128_000,
      maxInputTokens: 80_000,
      source: "error-reported",
    });
  });
});
