import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssertionResult, TaskVerifier } from "../../../src/types.ts";

interface AnalyticsModule {
  initializeSchema?: (pool: PoolLike) => Promise<void>;
  getDailyRevenueReport?: (pool: PoolLike) => Promise<unknown>;
  getCustomerLifetimeValue?: (pool: PoolLike, minNetCents?: number) => Promise<unknown>;
}

interface PoolLike {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

const verify: TaskVerifier = async (context) => {
  const modulePath = resolve(context.workspacePath, "src", "analytics.ts");
  const imported = (await import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`)) as AnalyticsModule;
  const assertions: AssertionResult[] = [];

  assertions.push({
    name: "exports analytics functions",
    passed:
      typeof imported.initializeSchema === "function" &&
      typeof imported.getDailyRevenueReport === "function" &&
      typeof imported.getCustomerLifetimeValue === "function",
    message: "initializeSchema, getDailyRevenueReport, and getCustomerLifetimeValue must be exported.",
  });

  if (!assertions[0]?.passed) {
    return { passed: false, score: 0, assertions };
  }

  const pool = createWorkspacePool(context.workspacePath);

  try {
    await runCase(assertions, "initializes the Postgres schema", async () => {
      await resetDatabase(pool);
      await imported.initializeSchema?.(pool);
      await seedHiddenData(pool);
    });

    await runCase(
      assertions,
      "daily revenue report aggregates completed orders without join multiplication",
      async () => {
        await resetDatabase(pool);
        await imported.initializeSchema?.(pool);
        await seedHiddenData(pool);

        assert.deepEqual(await imported.getDailyRevenueReport?.(pool), [
          {
            day: "2026-06-17",
            region: "emea",
            orderCount: 2,
            grossCents: 11500,
            refundCents: 2200,
            netCents: 9300,
            uniqueCustomers: 2,
          },
          {
            day: "2026-06-18",
            region: "apac",
            orderCount: 1,
            grossCents: 2500,
            refundCents: 3000,
            netCents: -500,
            uniqueCustomers: 1,
          },
          {
            day: "2026-06-18",
            region: "na",
            orderCount: 1,
            grossCents: 6000,
            refundCents: 0,
            netCents: 6000,
            uniqueCustomers: 1,
          },
        ]);
      }
    );

    await runCase(assertions, "customer lifetime value filters by net revenue", async () => {
      await resetDatabase(pool);
      await imported.initializeSchema?.(pool);
      await seedHiddenData(pool);

      assert.deepEqual(await imported.getCustomerLifetimeValue?.(pool, 6000), [
        {
          customerId: 2,
          email: "grace@example.com",
          region: "emea",
          completedOrders: 1,
          grossCents: 8000,
          refundCents: 1500,
          netCents: 6500,
        },
        {
          customerId: 3,
          email: "lin@example.com",
          region: "na",
          completedOrders: 1,
          grossCents: 6000,
          refundCents: 0,
          netCents: 6000,
        },
      ]);
    });
  } finally {
    await pool.end();
  }

  return { passed: assertions.every((assertion) => assertion.passed), score: 1, assertions };
};

export default verify;

function createWorkspacePool(workspacePath: string): PoolLike {
  const require = createRequire(resolve(workspacePath, "package.json"));
  const pg = require("pg") as { Pool: new (config: { connectionString: string }) => PoolLike };
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://mini_bench:mini_bench@localhost:55432/mini_bench",
  });
}

async function runCase(assertions: AssertionResult[], name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    assertions.push({ name, passed: true, message: "Behavior matched hidden case." });
  } catch (error) {
    assertions.push({
      name,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resetDatabase(pool: PoolLike): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; SET search_path TO public");
}

async function seedHiddenData(pool: PoolLike): Promise<void> {
  await pool.query(`
    INSERT INTO customers(id, email, region, status) VALUES
      (1, 'ada@example.com', 'emea', 'active'),
      (2, 'grace@example.com', 'emea', 'active'),
      (3, 'lin@example.com', 'na', 'active'),
      (4, 'max@example.com', 'apac', 'inactive');

    INSERT INTO orders(id, customer_id, placed_at, status, currency) VALUES
      (1001, 1, '2026-06-17T09:15:00Z', 'paid', 'USD'),
      (1002, 2, '2026-06-17T14:20:00Z', 'delivered', 'USD'),
      (1003, 1, '2026-06-17T16:00:00Z', 'canceled', 'USD'),
      (1004, 3, '2026-06-18T10:30:00Z', 'shipped', 'USD'),
      (1005, 4, '2026-06-18T11:45:00Z', 'paid', 'USD'),
      (1006, 1, '2026-06-19T08:00:00Z', 'refunded', 'USD');

    INSERT INTO order_items(order_id, sku, quantity, unit_price_cents) VALUES
      (1001, 'book', 2, 1500),
      (1001, 'pen', 1, 500),
      (1002, 'chair', 1, 8000),
      (1003, 'ignored-canceled', 1, 9999),
      (1004, 'lamp', 3, 2000),
      (1005, 'shirt', 1, 2500),
      (1006, 'ignored-refunded-status', 1, 7000);

    INSERT INTO refunds(id, order_id, refunded_at, amount_cents) VALUES
      (9001, 1001, '2026-06-19T12:00:00Z', 700),
      (9002, 1002, '2026-06-20T12:00:00Z', 500),
      (9003, 1002, '2026-06-21T12:00:00Z', 1000),
      (9004, 1003, '2026-06-22T12:00:00Z', 999),
      (9005, 1005, '2026-06-23T12:00:00Z', 3000);
  `);
}
