import assert from "node:assert/strict";
import pg from "pg";
import { getCustomerLifetimeValue, getDailyRevenueReport, initializeSchema } from "./analytics.ts";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; SET search_path TO public");
  await initializeSchema(pool);
  await seedPublicData();

  assert.deepEqual(await getDailyRevenueReport(pool), [
    {
      day: "2026-06-17",
      region: "emea",
      orderCount: 1,
      grossCents: 3500,
      refundCents: 500,
      netCents: 3000,
      uniqueCustomers: 1,
    },
    {
      day: "2026-06-18",
      region: "na",
      orderCount: 1,
      grossCents: 4200,
      refundCents: 0,
      netCents: 4200,
      uniqueCustomers: 1,
    },
  ]);

  assert.deepEqual(await getCustomerLifetimeValue(pool, 3000), [
    {
      customerId: 1,
      email: "ada@example.com",
      region: "emea",
      completedOrders: 1,
      grossCents: 3500,
      refundCents: 500,
      netCents: 3000,
    },
    {
      customerId: 2,
      email: "lin@example.com",
      region: "na",
      completedOrders: 1,
      grossCents: 4200,
      refundCents: 0,
      netCents: 4200,
    },
  ]);

  console.log("postgres order analytics tests passed");
} finally {
  await pool.end();
}

async function seedPublicData(): Promise<void> {
  await pool.query(`
    INSERT INTO customers(id, email, region, status) VALUES
      (1, 'ada@example.com', 'emea', 'active'),
      (2, 'lin@example.com', 'na', 'active');

    INSERT INTO orders(id, customer_id, placed_at, status, currency) VALUES
      (101, 1, '2026-06-17T10:00:00Z', 'paid', 'USD'),
      (102, 1, '2026-06-17T11:00:00Z', 'pending', 'USD'),
      (103, 2, '2026-06-18T09:00:00Z', 'shipped', 'USD');

    INSERT INTO order_items(order_id, sku, quantity, unit_price_cents) VALUES
      (101, 'book', 2, 1500),
      (101, 'pen', 1, 500),
      (102, 'ignored', 1, 9999),
      (103, 'bag', 1, 4200);

    INSERT INTO refunds(id, order_id, refunded_at, amount_cents) VALUES
      (9001, 101, '2026-06-19T12:00:00Z', 500);
  `);
}
