import assert from "node:assert/strict";
import { migrateConfigs } from "./migrate.ts";

const result = migrateConfigs([
  {
    id: "billing",
    enabled: false,
    settings: {
      retries: "4",
      timeoutMs: 12000,
      tags: " Core, payments,core ",
    },
    metadata: {
      owner: "platform",
    },
    legacyFlag: "keep-me",
  },
  {
    id: "",
    settings: {
      retries: 1,
    },
  },
  {
    id: "search",
    settings: {
      tags: ["API", " api ", "", "Search"],
    },
  },
]);

assert.deepEqual(result.configs, [
  {
    version: 2,
    id: "billing",
    enabled: false,
    retry: {
      maxAttempts: 4,
      timeoutMs: 12000,
    },
    tags: ["core", "payments"],
    metadata: {
      owner: "platform",
    },
    extras: {
      legacyFlag: "keep-me",
    },
  },
  {
    version: 2,
    id: "search",
    enabled: true,
    retry: {
      maxAttempts: 3,
      timeoutMs: 5000,
    },
    tags: ["api", "search"],
    metadata: {},
    extras: {},
  },
]);

assert.equal(result.errors.length, 1);
assert.equal(result.errors[0]?.index, 1);
assert.equal(result.errors[0]?.code, "invalid_id");

console.log("migration tests passed");
